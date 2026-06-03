/**
 * Hybrid NDCG@10: float32 embeddings vs per-vector int8 quantization (same BM25 + rerank).
 */
import { clearCache } from "../src/cache.ts";
import { getEmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import type { VectorIndex } from "../src/index/dense.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { hybridSearch } from "../src/search.ts";
import {
  benchmarkDir,
  formatMb,
  groupByRepo,
  loadBenchmarkTasks,
  loadRepoSpecs,
  ndcgAtK,
  requireRepoSpec,
  targetRank,
} from "./benchmark-lib.ts";

const TOP_K = 10;

const args = process.argv.slice(2);
const repoFilter = new Set<string>();
let fresh = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo" && args[i + 1]) {
    const repo = args[++i];
    if (repo) {
      repoFilter.add(repo);
    }
  } else if (args[i] === "--fresh") {
    fresh = true;
  }
}

const specs = await loadRepoSpecs();
const tasks = await loadBenchmarkTasks(specs, repoFilter.size > 0 ? repoFilter : null);
if (tasks.length === 0) {
  console.error("No benchmark tasks matched filters.");
  process.exit(1);
}

const embeddings = getEmbeddingBackend();
const byRepo = groupByRepo(tasks);

console.error(
  "Hybrid NDCG@10 — float32 vs int8 (per-vector symmetric quant, same BM25 + rerank)\n",
);
console.error(
  `${"Repo".padEnd(12)} ${"Chunks".padStart(6)} ${"VecMem".padStart(10)} ${"Float".padStart(8)} ${"Int8".padStart(8)} ${"Delta".padStart(8)} ${"Mem%".padStart(6)}`,
);

const rows: Array<{
  repo: string;
  language: string;
  chunks: number;
  float10: number;
  quant10: number;
  floatMem: number;
  quantMem: number;
}> = [];

for (const [repo, repoTasks] of [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const spec = requireRepoSpec(specs, repo);
  const dir = benchmarkDir(spec);
  if (fresh) {
    await clearCache(dir);
  }

  try {
    process.env.MIRU_FLOAT_VECTORS = "1";
    const {
      bm25,
      semantic: floatSemantic,
      chunks,
    } = await createIndexFromPath(dir, embeddings, ["code"], dir);
    delete process.env.MIRU_FLOAT_VECTORS;

    const quantSemantic = new QuantizedVectorIndex([
      ...(floatSemantic as VectorIndex).getVectors(),
    ]);
    const floatMem = floatSemantic.memoryBytes();
    const quantMem = quantSemantic.memoryBytes();

    let floatSum = 0;
    let quantSum = 0;
    for (const task of repoTasks) {
      const common = {
        query: task.query,
        embeddings,
        bm25Index: bm25,
        chunks,
        topK: TOP_K,
        rerank: true,
      };
      const floatResults = await hybridSearch({
        ...common,
        semanticIndex: floatSemantic,
      });
      const quantResults = await hybridSearch({
        ...common,
        semanticIndex: quantSemantic,
      });

      const floatRanks = task.allRelevant
        .map((t) => targetRank(floatResults, t))
        .filter((r): r is number => r != null);
      const quantRanks = task.allRelevant
        .map((t) => targetRank(quantResults, t))
        .filter((r): r is number => r != null);

      floatSum += ndcgAtK(floatRanks, task.allRelevant.length, TOP_K);
      quantSum += ndcgAtK(quantRanks, task.allRelevant.length, TOP_K);
    }

    const n = repoTasks.length;
    const float10 = floatSum / n;
    const quant10 = quantSum / n;
    const delta = quant10 - float10;
    const memPct = (quantMem / floatMem) * 100;

    rows.push({
      repo,
      language: spec.language,
      chunks: chunks.length,
      float10,
      quant10,
      floatMem,
      quantMem,
    });

    console.error(
      `${repo.padEnd(12)} ${String(chunks.length).padStart(6)} ${formatMb(floatMem).padStart(10)} ${float10.toFixed(3).padStart(8)} ${quant10.toFixed(3).padStart(8)} ${delta.toFixed(3).padStart(8)} ${memPct.toFixed(0).padStart(5)}%`,
    );
  } catch (err) {
    console.error(`${repo.padEnd(12)} FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

if (rows.length > 0) {
  const meanFloat = rows.reduce((a, r) => a + r.float10, 0) / rows.length;
  const meanQuant = rows.reduce((a, r) => a + r.quant10, 0) / rows.length;
  const totalFloatMem = rows.reduce((a, r) => a + r.floatMem, 0);
  const totalQuantMem = rows.reduce((a, r) => a + r.quantMem, 0);

  console.error("");
  console.error(
    `Mean NDCG@10: float32=${meanFloat.toFixed(3)}  int8=${meanQuant.toFixed(3)}  delta=${(meanQuant - meanFloat).toFixed(3)}`,
  );
  console.error(
    `Vector RAM (sum across repos indexed this run): float32=${formatMb(totalFloatMem)}  int8=${formatMb(totalQuantMem)}  (${((totalQuantMem / totalFloatMem) * 100).toFixed(1)}%)`,
  );

  const langs = [...new Set(rows.map((r) => r.language))].sort();
  console.error("\nBy language (mean NDCG@10):");
  for (const lang of langs) {
    const lr = rows.filter((r) => r.language === lang);
    const f = lr.reduce((a, r) => a + r.float10, 0) / lr.length;
    const q = lr.reduce((a, r) => a + r.quant10, 0) / lr.length;
    console.error(
      `  ${lang.padEnd(12)} float=${f.toFixed(3)}  int8=${q.toFixed(3)}  delta=${(q - f).toFixed(3)}  (n=${lr.length})`,
    );
  }

  let floatWins = 0;
  let quantWins = 0;
  for (const r of rows) {
    if (r.quant10 > r.float10 + 0.0005) {
      quantWins++;
    } else if (r.float10 > r.quant10 + 0.0005) {
      floatWins++;
    }
  }
  console.error(
    `\nRepo wins: float32=${floatWins}  int8=${quantWins}  tie=${rows.length - floatWins - quantWins}`,
  );

  console.log(
    JSON.stringify({
      mode: "hybrid",
      quantization: "int8-per-vector-symmetric",
      repos: rows,
      mean_ndcg10_float32: meanFloat,
      mean_ndcg10_int8: meanQuant,
      vector_memory_ratio: totalQuantMem / totalFloatMem,
    }),
  );
}
