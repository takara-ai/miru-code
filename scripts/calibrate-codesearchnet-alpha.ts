/** Tune Miru's semantic/BM25 blend on the cached CodeSearchNet corpus. */
import { join } from "node:path";
import { findIndexCachePath } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { dedupeResultsByFile } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const DATASET = "code-search-net/code_search_net";
const LANGUAGES = ["go", "java", "javascript", "php", "python", "ruby"] as const;
const PER_LANGUAGE = 500;
const EVAL_PER_LANGUAGE = Number.parseInt(process.env.MIRU_CALIBRATION_PER_LANGUAGE ?? "100", 10);
const TOP_K = 3;
const CORPUS_ROOT = join(process.cwd(), ".cache", "codesearchnet-compression-v1");
const VECTOR_CACHE = join(CORPUS_ROOT, ".query-vectors-v1.json");
const ALPHAS = (process.env.MIRU_CALIBRATION_ALPHAS ?? "0.35,0.5,0.65,0.8")
  .split(",")
  .map((value) => Number.parseFloat(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
if (ALPHAS.length === 0) {
  throw new Error("MIRU_CALIBRATION_ALPHAS must contain one or more values between 0 and 1.");
}

interface DatasetRow {
  func_documentation_string: string;
}

interface QueryCase {
  query: string;
  filePath: string;
  language: string;
}

async function fetchCases(): Promise<QueryCase[]> {
  const cached = Bun.file(VECTOR_CACHE);
  if (await cached.exists()) {
    const data = (await cached.json()) as { queries?: string[] };
    if (data.queries?.length === LANGUAGES.length * PER_LANGUAGE) {
      console.error("Using cached CodeSearchNet labels.");
      return data.queries.map((query, index) => {
        const language = LANGUAGES[Math.floor(index / PER_LANGUAGE)];
        if (!language) throw new Error(`No language for cached query ${index}`);
        const fileIndex = index % PER_LANGUAGE;
        const extension =
          language === "javascript"
            ? "js"
            : language === "python"
              ? "py"
              : language === "ruby"
                ? "rb"
                : language;
        return {
          query,
          filePath: `${language}/${String(fileIndex).padStart(4, "0")}.${extension}`,
          language,
        };
      });
    }
  }
  const cases: QueryCase[] = [];
  for (const language of LANGUAGES) {
    for (let offset = 0; offset < PER_LANGUAGE; offset += 100) {
      const url = new URL("https://datasets-server.huggingface.co/rows");
      url.searchParams.set("dataset", DATASET);
      url.searchParams.set("config", language);
      url.searchParams.set("split", "test");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("length", "100");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CodeSearchNet ${language}/${offset}: ${response.status}`);
      const body = (await response.json()) as { rows?: Array<{ row?: DatasetRow }> };
      for (const [i, entry] of (body.rows ?? []).entries()) {
        const query = entry.row?.func_documentation_string?.trim();
        if (query) {
          cases.push({
            query,
            filePath: `${language}/${String(offset + i).padStart(4, "0")}.${language === "javascript" ? "js" : language === "python" ? "py" : language === "ruby" ? "rb" : language}`,
            language,
          });
        }
      }
    }
  }
  if (cases.length !== LANGUAGES.length * PER_LANGUAGE) {
    throw new Error(`Expected 3000 cases, received ${cases.length}`);
  }
  return cases;
}

function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

async function queryVectors(index: MiruIndex, cases: QueryCase[]): Promise<Float32Array[]> {
  const cached = Bun.file(VECTOR_CACHE);
  if (await cached.exists()) {
    const data = (await cached.json()) as { queries: string[]; vectors: string[] };
    if (
      data.queries.length === cases.length &&
      data.queries.every((query, i) => query === cases[i]?.query)
    ) {
      console.error("Using cached live query embeddings.");
      return data.vectors.map(decodeVector);
    }
  }
  if (!index.embeddings.embedInputs) {
    throw new Error("Configured embedding backend does not support batched query embeddings.");
  }
  console.error(`Embedding ${cases.length} queries once for all alpha variants...`);
  const vectors: Float32Array[] = [];
  for (let start = 0; start < cases.length; start += 360) {
    const batch = cases.slice(start, start + 360).map((item) => item.query);
    vectors.push(...(await index.embeddings.embedInputs(batch)));
  }
  await Bun.write(
    VECTOR_CACHE,
    JSON.stringify({
      queries: cases.map((item) => item.query),
      vectors: vectors.map((vector) =>
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64"),
      ),
    }),
  );
  return vectors;
}

async function evaluate(
  index: MiruIndex,
  cases: QueryCase[],
  vectors: Float32Array[],
  alpha: number,
) {
  let top1 = 0;
  let hit3 = 0;
  let reciprocal = 0;
  const byLanguage = new Map<
    string,
    { count: number; top1: number; hit3: number; reciprocal: number }
  >();
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const vector = vectors[i];
    if (!item || !vector) continue;
    const results = dedupeResultsByFile(
      await index.search({
        query: item.query,
        queryVector: vector,
        topK: TOP_K,
        alpha,
        rerank: true,
      }),
    ).slice(0, TOP_K);
    const rank = results.findIndex((result) => result.chunk.file_path === item.filePath);
    const group = byLanguage.get(item.language) ?? { count: 0, top1: 0, hit3: 0, reciprocal: 0 };
    group.count++;
    if (rank === 0) {
      top1++;
      group.top1++;
    }
    if (rank >= 0) {
      hit3++;
      group.hit3++;
      reciprocal += 1 / (rank + 1);
      group.reciprocal += 1 / (rank + 1);
    }
    byLanguage.set(item.language, group);
  }
  const count = cases.length;
  return {
    alpha,
    exact_match_at_1: top1 / count,
    hit_at_3: hit3 / count,
    mrr: reciprocal / count,
    by_language: Object.fromEntries(
      [...byLanguage].map(([language, row]) => [
        language,
        {
          exact_match_at_1: row.top1 / row.count,
          hit_at_3: row.hit3 / row.count,
          mrr: row.reciprocal / row.count,
        },
      ]),
    ),
  };
}

const cases = await fetchCases();
// Calibration must not race to rebuild the corpus when several workers run.
const index = await MiruIndex.loadFromDisk(findIndexCachePath(CORPUS_ROOT));
const vectors = await queryVectors(index, cases);
const selectedIndices = LANGUAGES.flatMap((language) =>
  cases
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.language === language)
    .slice(0, EVAL_PER_LANGUAGE)
    .map(({ index }) => index),
);
const evalCases = selectedIndices.flatMap((index) => (cases[index] ? [cases[index]] : []));
const evalVectors = selectedIndices.flatMap((index) => (vectors[index] ? [vectors[index]] : []));
if (evalCases.length !== evalVectors.length || evalCases.length === 0) {
  throw new Error("No aligned cached query vectors available for calibration.");
}
const results = [];
for (const alpha of ALPHAS) {
  console.error(`Evaluating alpha=${alpha} using cached document and query vectors...`);
  results.push(await evaluate(index, evalCases, evalVectors, alpha));
}
console.error(
  results
    .map((row) => {
      return [
        `alpha=${row.alpha}`,
        `top1=${(row.exact_match_at_1 * 100).toFixed(1)}%`,
        `hit3=${(row.hit_at_3 * 100).toFixed(1)}%`,
        `mrr=${row.mrr.toFixed(3)}`,
      ].join("  ");
    })
    .join("\n"),
);
console.log(
  JSON.stringify(
    {
      dataset: DATASET,
      corpus_examples: cases.length,
      calibration_examples: evalCases.length,
      per_language: EVAL_PER_LANGUAGE,
      results,
    },
    null,
    2,
  ),
);
