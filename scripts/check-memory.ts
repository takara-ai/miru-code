/** Offline memory soak: int8 search, real BM25 workers, cache churn and AST cleanup. */
import { heapStats } from "bun:jsc";
import { chunkAst } from "../src/chunking/ast.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { MiruIndex } from "../src/miru-index.ts";
import {
  buildAlwaysOnRankFeatures,
  clearAlwaysOnFeatureCache,
} from "../src/ranking/always-on-features.ts";
import { clearRankFeatureCache } from "../src/ranking/learned-features.ts";
import { activeResidualRanker } from "../src/ranking/residual-ranker.ts";
import { type Chunk, chunkKey } from "../src/types.ts";

const output = Bun.argv[2] ?? ".cache/memory-audit/soak.json";
const queries = [
  "how the cache updates changed source files",
  "ParseRequest",
  "src/parser.ts",
  "how HttpClient resolves endpoint errors",
  "文字列の処理",
  "как преобразовать текст",
];
process.env.MIRU_CONCURRENCY = "1";
process.env.MIRU_MCP_WATCH = "1";
delete process.env.MIRU_RESIDUAL_RANK_MODEL;
delete process.env.MIRU_RESIDUAL_TOP4;
globalThis.fetch = (() => {
  throw Error("Network is disabled for memory soak");
}) as typeof fetch;
const vector = new Float32Array(64).fill(1 / 8);
const backend: EmbeddingBackend = {
  model: "ds1-miru-int8",
  dimensions: 64,
  embedQuery: async () => vector,
  embedDocuments: async () => {
    throw Error("No encoding during memory soak");
  },
};
if (activeResidualRanker(queries[0] as string, backend.model)?.version !== "residual-v2")
  throw Error("Memory soak requires the default int8 residual ranking configuration");
const makeChunks = (generation: number, count = 768): Chunk[] =>
  Array.from({ length: count }, (_, i) => ({
    content: `export function parseRequest${i}(request) {\n  // cache parser endpoint generation ${generation}\n  return request.text.normalize();\n}\n`,
    file_path: `src/${generation}/parser-${Math.floor(i / 2)}.ts`,
    start_line: i % 2 ? 6 : 1,
    end_line: i % 2 ? 9 : 4,
    language: "typescript",
  }));
function makeIndex(generation = 0) {
  const chunks = makeChunks(generation);
  const index = new MiruIndex({
    embeddings: backend,
    embeddingModel: backend.model,
    content: ["code"],
    chunks,
    bm25Index: buildBm25FromChunks(chunks),
    semanticIndex: new QuantizedVectorIndex(chunks.map(() => vector)),
  });
  index.saveToCache = async () => {};
  return index;
}
async function collect() {
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(0);
    Bun.gc(true);
  }
}
async function sample(label: string) {
  await collect();
  const heap = heapStats();
  return {
    label,
    heapBytes: heap.heapSize,
    extraBytes: heap.extraMemorySize,
    rssBytes: process.memoryUsage().rss,
    objects: heap.objectCount,
    promises: heap.objectTypeCounts.Promise ?? 0,
  };
}
function probeChunkOwnership() {
  clearAlwaysOnFeatureCache();
  clearRankFeatureCache();
  const chunks = makeChunks(1000, 128);
  const prior = chunks.map((chunk) => ({ chunk, score: 1 }));
  const scores = new Map(chunks.map((chunk) => [chunkKey(chunk), 1]));
  buildAlwaysOnRankFeatures("parser endpoint", scores, scores, prior, prior);
  return chunks.map((chunk) => new WeakRef(chunk));
}
const chunkRefs = probeChunkOwnership();
await collect();
const retainedChunks = chunkRefs.filter((ref) => ref.deref()).length;
await Bun.sleep(0);

async function searchSoak() {
  const index = makeIndex();
  const expected = new Map<string, string>();
  const run = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const query = queries[i % queries.length] as string;
      const result = await index.search({ query, topK: 4 });
      const signature = JSON.stringify(result.map(({ chunk, score }) => [chunkKey(chunk), score]));
      const previous = expected.get(query);
      if (previous !== undefined && previous !== signature)
        throw Error("Search output drifted during soak");
      expected.set(query, signature);
      if (i % 64 === 0) await Bun.sleep(0);
    }
  };
  await run(512);
  const snapshots = [await sample("search-warm-512")];
  for (let i = 0; i < 8; i++) {
    await run(512);
    snapshots.push(await sample(`search-${1024 + i * 512}`));
  }
  process.env.MIRU_CONCURRENCY = "2";
  await run(24);
  const workers = [await sample("workers-warm-24")];
  for (let i = 0; i < 5; i++) {
    await run(24);
    workers.push(await sample(`workers-${48 + i * 24}`));
  }
  process.env.MIRU_CONCURRENCY = "1";
  return { snapshots, workers, queries: 4608, workerQueries: 144, identicalResults: true };
}
const search = await searchSoak();
await collect();

async function cacheCycle() {
  let created = 0,
    active = 0,
    peak = 0,
    closed = 0;
  const refs: WeakRef<MiruIndex>[] = [];
  const cache = new IndexCache(["code"], null, {
    fromSource: async () => {
      const index = makeIndex(++created);
      refs.push(new WeakRef(index));
      return index;
    },
    watch: (() => {
      active++;
      peak = Math.max(peak, active);
      return {
        close() {
          active--;
          closed++;
        },
      };
    }) as never,
  });
  const snapshots = [];
  let index: MiruIndex | null = null;
  for (let batch = 0; batch < 6; batch++) {
    for (let i = 0; i < 20; i++) {
      index = await cache.get(`/memory-soak/repo-${batch * 20 + i}`);
      await index.search({ query: queries[i % queries.length] as string, topK: 4 });
      index = null;
    }
    snapshots.push(await sample(`index-cycles-${(batch + 1) * 20}`));
  }
  cache.close();
  return { refs, snapshots, created, active, peak, closed };
}
const cycles = await cacheCycle();

async function astSoak() {
  const source = Array.from(
    { length: 30 },
    (_, i) => `export function parse${i}(value) { return value.trim().toLowerCase(); }`,
  ).join("\n");
  const run = async () => {
    for (let i = 0; i < 250; i++) {
      if (!(await chunkAst(source, "test.ts", "typescript", 1500)))
        throw Error("AST fixture did not parse");
    }
  };
  await run();
  const snapshots = [await sample("ast-warm-250")];
  for (let i = 0; i < 4; i++) {
    await run();
    snapshots.push(await sample(`ast-${500 + i * 250}`));
  }
  return snapshots;
}
const ast = await astSoak();
await collect();
const retainedIndexes = cycles.refs.filter((ref) => ref.deref()).length;
await Bun.sleep(0);
const delta = (snapshots: Awaited<ReturnType<typeof sample>>[], field: "heapBytes" | "rssBytes") =>
  (snapshots.at(-1)?.[field] ?? 0) - (snapshots[0]?.[field] ?? 0);
const passed =
  retainedChunks === 0 &&
  retainedIndexes === 0 &&
  cycles.active === 0 &&
  cycles.peak <= 10 &&
  cycles.created === cycles.closed &&
  delta(search.snapshots, "heapBytes") < 4 * 1024 ** 2 &&
  delta(search.workers, "heapBytes") < 4 * 1024 ** 2 &&
  delta(search.workers, "rssBytes") < 64 * 1024 ** 2 &&
  delta(cycles.snapshots, "heapBytes") < 4 * 1024 ** 2 &&
  delta(ast, "heapBytes") < 4 * 1024 ** 2 &&
  delta(ast, "rssBytes") < 32 * 1024 ** 2;
const report = {
  passed,
  bunVersion: Bun.version,
  platform: process.platform,
  architecture: process.arch,
  networkRequests: 0,
  encodingCalls: 0,
  forcedCollection: true,
  retainedChunks,
  retainedIndexes,
  search,
  cache: {
    created: cycles.created,
    watchersClosed: cycles.closed,
    remainingWatchers: cycles.active,
    peakWatchers: cycles.peak,
    snapshots: cycles.snapshots,
  },
  ast: { parses: 1250, snapshots: ast },
  deltas: {
    searchHeapBytes: delta(search.snapshots, "heapBytes"),
    workersHeapBytes: delta(search.workers, "heapBytes"),
    workersRssBytes: delta(search.workers, "rssBytes"),
    cacheHeapBytes: delta(cycles.snapshots, "heapBytes"),
    astHeapBytes: delta(ast, "heapBytes"),
    astRssBytes: delta(ast, "rssBytes"),
  },
  limits:
    "Finite offline workload; forced GC tests retained objects. RSS may retain allocator/WASM capacity. Not a proof of zero leaks in all workloads.",
};
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ output, passed, retainedChunks, retainedIndexes, deltas: report.deltas }),
);
if (!passed) process.exitCode = 1;
