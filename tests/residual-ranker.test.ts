import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import type { BM25Index } from "../src/index/bm25.ts";
import type { SemanticIndex } from "../src/index/semantic-index.ts";
import type { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { RANK_FEATURE_NAMES } from "../src/ranking/learned-features.ts";
import {
  activeResidualRanker,
  predictResidual,
  type ResidualRankerModel,
  rankResidualCandidates,
  residualSearchResultCount,
  validateResidualModel,
} from "../src/ranking/residual-ranker.ts";
import {
  prepareHybridCandidates,
  rankBaseHybridCandidates,
  rankHybridCandidates,
} from "../src/search.ts";
import { type Chunk, chunkKey } from "../src/types.ts";
import parity from "./fixtures/ranking/residual-v2-parity.json";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

const names = [
  "MIRU_RESIDUAL_RANK_MODEL",
  "MIRU_RESIDUAL_TOP4",
  "MIRU_RANK_ALPHA",
  "MIRU_RANK_LINEAR_NORMALIZATION",
  "MIRU_RANK_FUSION",
] as const;
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const dirs: string[] = [];
afterEach(async () => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const query = "how text is converted into normalized numerical representations";
const fixture = (): ResidualRankerModel => ({
  version: "residual-v1",
  featureVersion: 2,
  features: [...RANK_FEATURE_NAMES],
  embeddingModel: "ds1-miru-int8",
  candidateTopK: 10,
  prior: { alpha: 0.4, normalization: "max", scale: 3 },
  featureBase: { alpha: 0.7, normalization: "minmax" },
  eta: 1,
  clip: 3,
  postprocessing: "bounded-residual-best-chunk-per-file",
  sourceModelSha256: "0".repeat(64),
  trees: [
    {
      feature: [0, -1, -1],
      threshold: [0.5, 0, 0],
      left: [1, -1, -1],
      right: [2, -1, -1],
      value: [0, -2, 3],
    },
  ],
});
const first: Chunk = {
  content: "function encode(text) { return text; }",
  file_path: "src/encoding.ts",
  start_line: 1,
  end_line: 1,
  language: "typescript",
};
const second: Chunk = {
  ...first,
  file_path: "src/other.ts",
  content: "function normalize(input) { return input; }",
};
async function configure() {
  const dir = await mkdtemp(join(tmpdir(), "miru-residual-"));
  dirs.push(dir);
  const path = join(dir, "model.json");
  await Bun.write(path, JSON.stringify(fixture()));
  process.env.MIRU_RESIDUAL_RANK_MODEL = path;
  delete process.env.MIRU_RESIDUAL_TOP4;
  process.env.MIRU_RANK_FUSION = "linear";
  process.env.MIRU_RANK_LINEAR_NORMALIZATION = "max";
  delete process.env.MIRU_RANK_ALPHA;
}

test("the bundled scorer is enabled by default for every compatible code query", async () => {
  await configure();
  delete process.env.MIRU_RESIDUAL_RANK_MODEL;
  delete process.env.MIRU_RESIDUAL_TOP4;
  for (const text of [
    query,
    "Blueprint",
    "find the parser",
    "src/auth.ts",
    "文字列の処理",
    "как преобразовать текст в числовое представление для поиска",
  ]) {
    expect(activeResidualRanker(text, "ds1-miru-int8")?.version).toBe("residual-v2");
    expect(residualSearchResultCount(text, "ds1-miru-int8")).toBe(4);
  }
  process.env.MIRU_RESIDUAL_RANK_MODEL = "0";
  process.env.MIRU_RESIDUAL_TOP4 = "1";
  expect(activeResidualRanker(query, "ds1-miru-int8")).toBeNull();
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(5);
});

test("the bundled model matches the evaluated asset and native LightGBM predictions", async () => {
  await configure();
  delete process.env.MIRU_RESIDUAL_RANK_MODEL;
  const model = activeResidualRanker(query, "ds1-miru-int8");
  if (!model) throw Error("Bundled model missing");
  const bytes = await Bun.file(
    new URL("../src/ranking/residual-model.json", import.meta.url),
  ).arrayBuffer();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(parity.modelSha256);
  expect(model.sourceModelSha256).toBe(parity.sourceModelSha256);
  expect(model.trees).toHaveLength(200);
  for (let i = 0; i < parity.features.length; i++)
    expect(predictResidual(model, parity.features[i] as number[])).toBeCloseTo(
      parity.predictions[i] as number,
      12,
    );
});

test("residual contract rejects replacement models, unsafe tree links and nonfinite inputs", () => {
  const model = validateResidualModel(fixture());
  const x = Array(44).fill(0);
  x[0] = 0.5;
  expect(predictResidual(model, x)).toBe(-2);
  x[0] = 0.500001;
  expect(predictResidual(model, x)).toBe(3);
  x[0] = NaN;
  expect(() => predictResidual(model, x)).toThrow("feature vector");
  expect(() => validateResidualModel({ ...fixture(), version: 2 })).toThrow("incompatible");
  expect(() => validateResidualModel({ ...fixture(), eta: 2 })).toThrow("incompatible");
  const cyclic = fixture();
  const tree = cyclic.trees[0];
  if (!tree) throw Error("Missing tree");
  tree.left[0] = 0;
  expect(() => validateResidualModel(cyclic)).toThrow("point forward");
});

test("Unicode queries use the same residual scorer and candidate depth", async () => {
  await configure();
  const unsupported = "как преобразовать текст в числовое представление для поиска";
  expect(residualSearchResultCount(unsupported, "ds1-miru-int8")).toBe(4);
  expect(
    residualSearchResultCount("how ‘quoted’ values work — with punctuation", "ds1-miru-int8"),
  ).toBe(4);
  expect(activeResidualRanker(unsupported, "ds1-miru-int8")).not.toBeNull();
  let requested = 0;
  const options = {
    query: unsupported,
    chunks: [first, second],
    topK: residualSearchResultCount(unsupported, "ds1-miru-int8"),
    queryVector: new Float32Array([1]),
    embeddings: { model: "ds1-miru-int8" } as EmbeddingBackend,
    semanticIndex: {
      query(_v: Float32Array, k: number) {
        requested = k;
        return { indices: [0, 1], distances: [0.3, 0.2] };
      },
    } as unknown as SemanticIndex,
    bm25Index: { getScoresAsync: async () => [4, 3] } as unknown as BM25Index,
  };
  const pool = await prepareHybridCandidates(options);
  expect(requested).toBe(50);
  expect(rankHybridCandidates(pool, options)).not.toEqual(rankBaseHybridCandidates(pool, options));
});

test("residual corrections retain the prior and choose distinct files before truncation", () => {
  const model = fixture();
  model.trees = [{ feature: [-1], threshold: [0], left: [-1], right: [-1], value: [100] }];
  const duplicate = { ...first, start_line: 2, end_line: 2 };
  const prior = [
    { chunk: first, score: 1 },
    { chunk: second, score: 0.8 },
    { chunk: duplicate, score: 0.45 },
  ];
  const result = rankResidualCandidates(model, query, new Map(), new Map(), prior, prior, 2);
  expect(result.map((r) => r.chunk.file_path)).toEqual([first.file_path, second.file_path]);
  expect(result[0]?.score).toBe(6); // normalized prior 3 + clipped correction 3
  expect(result[1]?.score).toBeCloseTo(Math.fround(2.4) + 3, 10);
});

test("every query shape uses a compatible residual and the selected serving budget", async () => {
  await configure();
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(4);
  for (const text of [
    "where encoding starts",
    "Blueprint",
    "src/auth.ts",
    "find the parser implementation",
    "tokenizer vocabulary",
    "文字列の処理",
    "how parseUrl handles malformed input",
  ])
    expect(residualSearchResultCount(text, "ds1-miru-int8")).toBe(4);
  expect(residualSearchResultCount(query, "other-model")).toBe(5);
  expect(residualSearchResultCount(query, "ds1-miru-int8", false)).toBe(5);
  process.env.MIRU_RANK_ALPHA = ".7";
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(5);
  delete process.env.MIRU_RANK_ALPHA;
  delete process.env.MIRU_RESIDUAL_TOP4;
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(4);
  process.env.MIRU_RESIDUAL_TOP4 = "0";
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(5);
  expect(activeResidualRanker(query, "ds1-miru-int8")).not.toBeNull();
  process.env.MIRU_RESIDUAL_TOP4 = "1";
  expect(residualSearchResultCount(query, "ds1-miru-int8")).toBe(4);
  process.env.MIRU_RESIDUAL_RANK_MODEL = "/does/not/exist.json";
  expect(() => activeResidualRanker("Blueprint", "ds1-miru-int8")).toThrow();
  expect(activeResidualRanker(query, "other-model")).toBeNull();
  expect(activeResidualRanker(query, "ds1-miru-int8", undefined, false)).toBeNull();
});

test("actual retrieval widens every reranked query pool, including navigation", async () => {
  await configure();
  let requested = 0;
  const options = {
    query,
    chunks: [first, second],
    topK: 4,
    queryVector: new Float32Array([1]),
    embeddings: { model: "ds1-miru-int8" } as EmbeddingBackend,
    semanticIndex: {
      query(_v: Float32Array, k: number) {
        requested = k;
        return { indices: [0, 1], distances: [0.3, 0.2] };
      },
    } as unknown as SemanticIndex,
    bm25Index: { getScoresAsync: async () => [4, 3] } as unknown as BM25Index,
  };
  const pool = await prepareHybridCandidates(options);
  expect(requested).toBe(50);
  const reranked = rankHybridCandidates(pool, options);
  expect(reranked).toHaveLength(2);
  expect(reranked.map((r) => chunkKey(r.chunk))).toEqual([chunkKey(first), chunkKey(second)]);
  await prepareHybridCandidates({ ...options, rerank: false });
  expect(requested).toBe(20);
  const navigation = { ...options, query: "Blueprint", topK: 5 };
  const navPool = await prepareHybridCandidates(navigation);
  expect(requested).toBe(50);
  expect(rankHybridCandidates(navPool, navigation)).not.toEqual(
    rankBaseHybridCandidates(navPool, navigation),
  );
});

test("symbol discovery and reranking keep excluded files outside the result set", async () => {
  await configure();
  delete process.env.MIRU_RESIDUAL_RANK_MODEL;
  const allowed = { ...first, content: "export class HttpClient {}", file_path: "src/current.ts" };
  const excluded = { ...allowed, file_path: "private/HttpClient.ts" };
  const options = {
    query: "HttpClient",
    chunks: [allowed, excluded],
    selector: [0],
    topK: 4,
    queryVector: new Float32Array([1]),
    embeddings: { model: "ds1-miru-int8" } as EmbeddingBackend,
    semanticIndex: {
      query: () => ({ indices: [0], distances: [0.2] }),
    } as unknown as SemanticIndex,
    bm25Index: { getScoresAsync: async () => [1, 0] } as unknown as BM25Index,
  };
  const pool = await prepareHybridCandidates(options);
  const ranked = rankHybridCandidates(pool, options);
  expect(ranked).toHaveLength(1);
  expect(ranked[0]?.chunk).toBe(allowed);
});

test("MCP applies the chosen code budget to conceptual, navigation and Unicode queries", async () => {
  await configure();
  delete process.env.MIRU_RESIDUAL_RANK_MODEL;
  const requested: number[] = [];
  const index = {
    root: null,
    embeddingModel: "ds1-miru-int8",
    supportsCodeRanking: true,
    chunks: [first, second],
    async search(options: { topK: number }) {
      requested.push(options.topK);
      return [{ chunk: first, score: 1 }];
    },
  };
  const cache = { get: async () => index } as unknown as IndexCache;
  const call = (id: number, text: string) => ({
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name: "search", arguments: { query: text } },
  });
  const transport = new MemoryTransport([
    call(1, query),
    call(2, "Blueprint"),
    call(4, "как преобразовать текст в числовое представление для поиска"),
  ]);
  await createMcpServer(cache).connect(transport);
  expect(requested).toEqual([4, 4, 4]);
  expect(JSON.stringify(transport.responseFor(1))).toContain("encoding.ts");
  index.supportsCodeRanking = false;
  await createMcpServer(cache).connect(new MemoryTransport([call(3, query)]));
  expect(requested).toEqual([4, 4, 4, 5]);
});
