/**
 * NDCG@5/@10 retrieval benchmark aligned with miru-research/benchmarks/run_benchmark.py
 */
import { clearCache } from "../src/cache.ts";
import { resolveEmbeddingDimensions, resolveEmbeddingModel } from "../src/embeddings/openai.ts";
import { MiruIndex } from "../src/miru-index.ts";
import type { SearchResult } from "../src/types.ts";
import {
  type BenchmarkTask,
  benchmarkDir,
  groupByRepo,
  loadBenchmarkTasks,
  loadRepoSpecs,
  ndcgAtK,
  type RepoSpec,
  requireRepoSpec,
  targetRank,
} from "./benchmark-lib.ts";

const TOP_K = 10;
const LATENCY_RUNS = 5;

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo] ?? 0;
  }
  const w = idx - lo;
  return (sorted[lo] ?? 0) * (1 - w) + (sorted[hi] ?? 0) * w;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

interface EvalOptions {
  model: string;
  dimensions?: number;
  semanticOnly: boolean;
  verbose: boolean;
  fresh: boolean;
}

interface PerQueryResult {
  query: string;
  category: string;
  ndcg10: number;
  ranks: number[];
  nRel: number;
  topFiles: string[];
}

async function evaluateRepo(
  spec: RepoSpec,
  tasks: BenchmarkTask[],
  options: EvalOptions,
): Promise<{
  chunks: number;
  vectorDims: number;
  ndcg5: number;
  ndcg10: number;
  p50: number;
  p90: number;
  indexMs: number;
  tokens: number;
  perQuery: PerQueryResult[];
}> {
  const dir = benchmarkDir(spec);
  if (options.fresh) {
    await clearCache(dir);
  }

  const indexStart = performance.now();
  const index = await MiruIndex.fromPath(dir, ["code"], options.model);
  const indexMs = performance.now() - indexStart;
  const vectorDims = index.embeddings.dimensions;

  let ndcg5Sum = 0;
  let ndcg10Sum = 0;
  const latencies: number[] = [];
  let tokens = 0;
  const perQuery: PerQueryResult[] = [];

  for (const task of tasks) {
    const queryLatencies: number[] = [];
    let results: SearchResult[] = [];
    for (let run = 0; run < LATENCY_RUNS; run++) {
      const started = performance.now();
      results = await index.search({
        query: task.query,
        topK: TOP_K,
        rerank: !options.semanticOnly,
        alpha: options.semanticOnly ? 1.0 : null,
      });
      queryLatencies.push(performance.now() - started);
    }
    latencies.push(median(queryLatencies));

    const relevantRanks = task.allRelevant
      .map((t) => targetRank(results, t))
      .filter((r): r is number => r != null);
    const qNdcg5 = ndcgAtK(relevantRanks, task.allRelevant.length, 5);
    const qNdcg10 = ndcgAtK(relevantRanks, task.allRelevant.length, TOP_K);
    ndcg5Sum += qNdcg5;
    ndcg10Sum += qNdcg10;
    tokens += results.reduce((acc, r) => acc + Math.floor(r.chunk.content.length / 4), 0);

    perQuery.push({
      query: task.query,
      category: task.category,
      ndcg10: qNdcg10,
      ranks: relevantRanks,
      nRel: task.allRelevant.length,
      topFiles: results.slice(0, 5).map((r) => r.chunk.file_path),
    });

    if (options.verbose) {
      const targets = task.allRelevant.map((t) => t.path).join(", ");
      console.error(
        `  [${task.category.padEnd(12)}] ndcg@10=${qNdcg10.toFixed(3)} ranks=${JSON.stringify(relevantRanks)} n_rel=${task.allRelevant.length}`,
      );
      console.error(`               q=${JSON.stringify(task.query)}`);
      console.error(`               want: ${targets}`);
      console.error(`               top5: ${perQuery.at(-1)?.topFiles.join(", ")}`);
    }
  }

  const n = tasks.length;
  return {
    chunks: index.chunks.length,
    vectorDims,
    ndcg5: ndcg5Sum / n,
    ndcg10: ndcg10Sum / n,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    indexMs,
    tokens: Math.floor(tokens / n),
    perQuery,
  };
}

const args = process.argv.slice(2);
const repoFilter = new Set<string>();
let modelArg: string | undefined;
let dimensionsArg: number | undefined;
let semanticOnly = false;
let verbose = false;
let fresh = false;
let showWorst = 0;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) {
    continue;
  }
  if (arg === "--repo" && args[i + 1]) {
    const repo = args[++i];
    if (repo) {
      repoFilter.add(repo);
    }
  } else if (arg === "--model" && args[i + 1]) {
    modelArg = args[++i];
  } else if (arg === "--dimensions" && args[i + 1]) {
    const raw = args[++i];
    if (raw) {
      dimensionsArg = Number(raw);
    }
  } else if (arg === "--semantic-only") {
    semanticOnly = true;
  } else if (arg === "--verbose") {
    verbose = true;
  } else if (arg === "--fresh") {
    fresh = true;
  } else if (arg === "--worst" && args[i + 1]) {
    const raw = args[++i];
    if (raw) {
      showWorst = Number(raw);
    }
  }
}

if (modelArg) {
  process.env.MIRU_OPENAI_EMBEDDING_MODEL = modelArg;
}
if (dimensionsArg != null && Number.isFinite(dimensionsArg)) {
  process.env.MIRU_EMBEDDING_DIMENSIONS = String(dimensionsArg);
} else {
  delete process.env.MIRU_EMBEDDING_DIMENSIONS;
}

const specs = await loadRepoSpecs();
const tasks = await loadBenchmarkTasks(specs, repoFilter.size > 0 ? repoFilter : null);
if (tasks.length === 0) {
  console.error("No benchmark tasks matched filters.");
  process.exit(1);
}

const model = modelArg ?? resolveEmbeddingModel();
const dimensions = dimensionsArg ?? resolveEmbeddingDimensions(model);
const mode = semanticOnly ? "semantic-only" : "hybrid";

console.error(`Model: ${model}  dims: ${dimensions ?? "api-default"}  mode: ${mode}`);
console.error(
  `${"Repo".padEnd(12)} ${"Lang".padEnd(10)} ${"Dims".padStart(5)} ${"Chunks".padStart(6)} ${"index".padStart(9)} ${"NDCG@5".padStart(8)} ${"NDCG@10".padStart(8)} ${"p50".padStart(8)}`,
);

const evalOptions: EvalOptions = {
  model,
  dimensions,
  semanticOnly,
  verbose,
  fresh,
};

const byRepo = groupByRepo(tasks);
const results: Array<{
  repo: string;
  language: string;
  vectorDims: number;
  ndcg5: number;
  ndcg10: number;
}> = [];
const allQueries: Array<PerQueryResult & { repo: string }> = [];

for (const [repo, repoTasks] of [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const spec = requireRepoSpec(specs, repo);
  if (verbose) {
    console.error(`\n=== ${repo} (${repoTasks.length} tasks) ===`);
  }
  try {
    const r = await evaluateRepo(spec, repoTasks, evalOptions);
    if (dimensions != null && r.vectorDims !== dimensions) {
      throw new Error(`Index vectors are ${r.vectorDims}d, expected ${dimensions}d`);
    }
    results.push({
      repo,
      language: spec.language,
      vectorDims: r.vectorDims,
      ndcg5: r.ndcg5,
      ndcg10: r.ndcg10,
    });
    for (const q of r.perQuery) {
      allQueries.push({ ...q, repo });
    }
    console.error(
      `${repo.padEnd(12)} ${spec.language.padEnd(10)} ${String(r.vectorDims).padStart(5)} ${String(r.chunks).padStart(6)} ${`${Math.round(r.indexMs)}ms`.padStart(9)} ${r.ndcg5.toFixed(3).padStart(8)} ${r.ndcg10.toFixed(3).padStart(8)} ${`${r.p50.toFixed(1)}ms`.padStart(8)}`,
    );
  } catch (err) {
    console.error(`${repo.padEnd(12)} FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

if (results.length > 0) {
  const mean5 = results.reduce((a, r) => a + r.ndcg5, 0) / results.length;
  const mean10 = results.reduce((a, r) => a + r.ndcg10, 0) / results.length;
  console.error("");
  console.error(
    `Mean over ${results.length} repos: NDCG@5=${mean5.toFixed(3)}  NDCG@10=${mean10.toFixed(3)}`,
  );

  if (showWorst > 0) {
    console.error(`\nWorst ${showWorst} queries by NDCG@10:`);
    for (const q of [...allQueries].sort((a, b) => a.ndcg10 - b.ndcg10).slice(0, showWorst)) {
      console.error(
        `  ${q.repo} [${q.category}] ndcg=${q.ndcg10.toFixed(3)} ranks=${JSON.stringify(q.ranks)} q=${JSON.stringify(q.query)}`,
      );
      console.error(`    top5: ${q.topFiles.join(", ")}`);
    }
  }

  console.log(
    JSON.stringify({
      model,
      dimensions,
      mode,
      repos: results,
      mean_ndcg5: mean5,
      mean_ndcg10: mean10,
    }),
  );
}
