/**
 * Large labelled compression A/B on Hugging Face CodeSearchNet.
 *
 * Downloads a balanced test sample (500 query/function pairs in each of six
 * languages), indexes it with the configured live embedding endpoint, then
 * compares the old fixed ±15-line response window with Miru's structural
 * response formatter. Retrieval ranking is held constant between arms.
 *
 * Usage: bun run benchmark:codesearchnet-compression
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { anchorLineOffset, applySnippetsToResults, estimateResultTokens } from "../src/snippet.ts";
import type { Chunk } from "../src/types.ts";
import { dedupeResultsByFile } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const DATASET = "code-search-net/code_search_net";
const LANGUAGES = ["go", "java", "javascript", "php", "python", "ruby"] as const;
const PER_LANGUAGE = 500;
const PAGE_SIZE = 100;
const TOP_K = 3;
const LEGACY_SNIPPET_LINES = 15;
const CORPUS_ROOT = join(process.cwd(), ".cache", "codesearchnet-compression-v1");

const extensions: Record<(typeof LANGUAGES)[number], string> = {
  go: "go",
  java: "java",
  javascript: "js",
  php: "php",
  python: "py",
  ruby: "rb",
};

interface DatasetRow {
  func_code_string: string;
  func_documentation_string: string;
}

interface Case {
  query: string;
  filePath: string;
  language: (typeof LANGUAGES)[number];
}

async function fetchRows(language: (typeof LANGUAGES)[number]): Promise<DatasetRow[]> {
  const rows: DatasetRow[] = [];
  for (let offset = 0; offset < PER_LANGUAGE; offset += PAGE_SIZE) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", DATASET);
    url.searchParams.set("config", language);
    url.searchParams.set("split", "test");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(PAGE_SIZE));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CodeSearchNet ${language} page ${offset}: ${response.status}`);
    }
    const body = (await response.json()) as { rows?: Array<{ row?: DatasetRow }> };
    for (const entry of body.rows ?? []) {
      const row = entry.row;
      if (row?.func_code_string?.trim() && row.func_documentation_string?.trim()) {
        rows.push(row);
      }
    }
  }
  if (rows.length < PER_LANGUAGE) {
    throw new Error(`CodeSearchNet ${language}: only ${rows.length}/${PER_LANGUAGE} usable rows`);
  }
  return rows.slice(0, PER_LANGUAGE);
}

async function prepareCorpus(): Promise<{ cases: Case[]; sources: Map<string, Chunk> }> {
  await mkdir(CORPUS_ROOT, { recursive: true });
  const cases: Case[] = [];
  const sources = new Map<string, Chunk>();
  for (const language of LANGUAGES) {
    console.error(`Downloading ${language} test rows...`);
    const rows = await fetchRows(language);
    const folder = join(CORPUS_ROOT, language);
    await mkdir(folder, { recursive: true });
    for (const [index, row] of rows.entries()) {
      const filePath = `${language}/${String(index).padStart(4, "0")}.${extensions[language]}`;
      const content = `${row.func_code_string.trimEnd()}\n`;
      await Bun.write(join(CORPUS_ROOT, filePath), content);
      sources.set(filePath, {
        content,
        file_path: filePath,
        start_line: 1,
        end_line: content.split("\n").length,
        language,
      });
      cases.push({ query: row.func_documentation_string, filePath, language });
    }
  }
  return { cases, sources };
}

function legacySnippet(chunk: Chunk, query: string): Chunk {
  const lines = chunk.content.split("\n");
  const anchor = anchorLineOffset(chunk.content, query);
  const start = Math.max(0, anchor - LEGACY_SNIPPET_LINES);
  const end = Math.min(lines.length, anchor + LEGACY_SNIPPET_LINES + 1);
  return {
    ...chunk,
    content: lines.slice(start, end).join("\n"),
    start_line: chunk.start_line + start,
    end_line: chunk.start_line + Math.max(start, end - 1),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        const item = items[index];
        if (item !== undefined) output[index] = await fn(item);
      }
    }),
  );
  return output;
}

interface Metric {
  language: string;
  targetRank: number | null;
  baselineTokens: number;
  treatmentTokens: number;
  precisionAt3: number;
  hitAt3: boolean;
  reciprocalRank: number;
  rankIdentity: boolean;
  bestAnchorRetained: boolean;
}

const { cases, sources } = await prepareCorpus();
await clearCache(CORPUS_ROOT);
console.error(
  `Indexing ${cases.length} CodeSearchNet functions with the live embedding endpoint...`,
);
const index = await MiruIndex.fromPath(CORPUS_ROOT, ["code"]);
console.error(`Searching ${cases.length} labelled queries (concurrency 12)...`);

const metrics = await mapPool(cases, 12, async (spec): Promise<Metric> => {
  const results = dedupeResultsByFile(
    await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
  ).slice(0, TOP_K);
  const baseline = results.map((result) => ({
    ...result,
    chunk: legacySnippet(result.chunk, spec.query),
  }));
  const treatment = applySnippetsToResults(results, spec.query, undefined, sources);
  const targetRank = results.findIndex((result) => result.chunk.file_path === spec.filePath);
  const best = results[0];
  const bestOutput = treatment[0];
  const bestAnchor = best
    ? best.chunk.start_line + anchorLineOffset(best.chunk.content, spec.query)
    : null;
  const anchorText =
    best && bestAnchor !== null
      ? best.chunk.content.split("\n")[bestAnchor - best.chunk.start_line]?.trim()
      : "";
  return {
    language: spec.language,
    targetRank: targetRank >= 0 ? targetRank + 1 : null,
    baselineTokens: estimateResultTokens(baseline),
    treatmentTokens: estimateResultTokens(treatment.map((entry) => entry.result)),
    precisionAt3:
      results.filter((result) => result.chunk.file_path === spec.filePath).length / TOP_K,
    hitAt3: targetRank >= 0,
    reciprocalRank: targetRank >= 0 ? 1 / (targetRank + 1) : 0,
    rankIdentity:
      treatment.length === results.length &&
      treatment.every(
        (entry, position) => entry.result.chunk.file_path === results[position]?.chunk.file_path,
      ),
    bestAnchorRetained:
      bestAnchor !== null &&
      bestOutput?.meta.anchor_line === bestAnchor &&
      (!anchorText || bestOutput.result.chunk.content.includes(anchorText)),
  };
});

function summarize(rows: Metric[]) {
  const count = rows.length || 1;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / count;
  const baseline = mean(rows.map((row) => row.baselineTokens));
  const treatment = mean(rows.map((row) => row.treatmentTokens));
  return {
    examples: rows.length,
    baseline_tokens_per_query: baseline,
    treatment_tokens_per_query: treatment,
    token_reduction: baseline ? 1 - treatment / baseline : 0,
    // Each CodeSearchNet query has one labelled relevant function. Therefore
    // precision@3 cannot exceed 33.3% and is just hit@3 divided by three.
    exact_match_at_1: rows.filter((row) => row.targetRank === 1).length / count,
    precision_at_3_single_positive: mean(rows.map((row) => row.precisionAt3)),
    hit_at_3: rows.filter((row) => row.hitAt3).length / count,
    mrr: mean(rows.map((row) => row.reciprocalRank)),
    rank_identity: rows.filter((row) => row.rankIdentity).length / count,
    best_anchor_retention: rows.filter((row) => row.bestAnchorRetained).length / count,
    target_rank_distribution: {
      rank_1: rows.filter((row) => row.targetRank === 1).length / count,
      rank_2: rows.filter((row) => row.targetRank === 2).length / count,
      rank_3: rows.filter((row) => row.targetRank === 3).length / count,
      miss: rows.filter((row) => row.targetRank === null).length / count,
    },
  };
}

const overall = summarize(metrics);
const byLanguage = Object.fromEntries(
  LANGUAGES.map((language) => [
    language,
    summarize(metrics.filter((row) => row.language === language)),
  ]),
);
console.error("=== CODESearchNet structural compression A/B ===");
console.error(`  examples: ${overall.examples} across ${LANGUAGES.length} languages`);
console.error(
  `  tokens/query: ${overall.baseline_tokens_per_query.toFixed(1)} -> ${overall.treatment_tokens_per_query.toFixed(1)} (${(overall.token_reduction * 100).toFixed(1)}% fewer)`,
);
console.error(
  `  exact-match@1: ${(overall.exact_match_at_1 * 100).toFixed(1)}%  hit@3: ${(overall.hit_at_3 * 100).toFixed(1)}%  MRR: ${overall.mrr.toFixed(3)}`,
);
console.error(
  `  rank identity: ${(overall.rank_identity * 100).toFixed(1)}%  best-anchor retention: ${(overall.best_anchor_retention * 100).toFixed(1)}%`,
);
console.log(
  JSON.stringify(
    { dataset: DATASET, sample_per_language: PER_LANGUAGE, overall, by_language: byLanguage },
    null,
    2,
  ),
);
