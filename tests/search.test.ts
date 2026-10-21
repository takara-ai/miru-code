import { describe, expect, test } from "bun:test";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import {
  hybridSearch,
  normalizeScores,
  prepareHybridCandidates,
  rankHybridCandidates,
} from "../src/search.ts";
import type { Chunk } from "../src/types.ts";
import { unitVector } from "./test-helpers.ts";

function chunk(content: string, file = "src/a.ts"): Chunk {
  return {
    content,
    file_path: file,
    start_line: 1,
    end_line: 10,
    language: "typescript",
  };
}

function mockEmbeddings(vectors: Float32Array[]): EmbeddingBackend {
  const dim = vectors[0]?.length ?? 4;
  return {
    model: "mock",
    dimensions: dim,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => {
        const index = Number.parseInt(text, 10);
        if (Number.isNaN(index)) {
          return vectors[0] ?? new Float32Array(dim);
        }
        const vec = vectors[index];
        if (!vec) {
          throw new Error(`Missing mock vector for ${text}`);
        }
        return vec;
      });
    },
    async embedQuery(text: string) {
      const parsed = Number.parseInt(text, 10);
      if (!Number.isNaN(parsed)) {
        const [vec] = await this.embedDocuments([text]);
        if (vec) {
          return vec;
        }
      }
      return vectors[0] ?? new Float32Array(dim);
    },
  };
}

describe("score normalization", () => {
  test("preserves score gaps and handles empty, singleton and tied lists", () => {
    expect([...normalizeScores(new Map()).values()]).toEqual([]);
    expect([...normalizeScores(new Map([["a", 2]])).values()]).toEqual([1]);
    expect([
      ...normalizeScores(
        new Map([
          ["a", 0],
          ["b", 0],
        ]),
      ).values(),
    ]).toEqual([0, 0]);
    expect([
      ...normalizeScores(
        new Map([
          ["a", 2],
          ["b", 2],
        ]),
      ).values(),
    ]).toEqual([1, 1]);
    const normalized = normalizeScores(
      new Map([
        ["a", -1],
        ["b", 0.8],
        ["c", 1],
      ]),
    );
    expect(normalized.get("a")).toBe(0);
    expect(normalized.get("b")).toBeCloseTo(0.9);
    expect(normalized.get("c")).toBe(1);
    expect([
      ...normalizeScores(
        new Map([
          ["a", -1],
          ["b", 0.8],
          ["c", 1],
        ]),
        "max",
      ).values(),
    ]).toEqual([0, 0.8, 1]);
    expect([...normalizeScores(new Map([["a", -1]]), "max").values()]).toEqual([0]);
  });
});

describe("hybridSearch", () => {
  test("linear fusion scores both modalities for the union; RRF retains truncated lists", async () => {
    const previousFusion = process.env.MIRU_RANK_FUSION;
    const previousDepth = process.env.MIRU_RANK_CANDIDATE_MULTIPLIER;
    process.env.MIRU_RANK_CANDIDATE_MULTIPLIER = "1";
    try {
      const chunks = [chunk("a", "a.ts"), chunk("b", "b.ts"), chunk("c", "c.ts")];
      const options = {
        query: "example",
        queryVector: new Float32Array([1, 0]),
        embeddings: mockEmbeddings([]),
        semanticIndex: new VectorIndex([
          new Float32Array([1, 0]),
          new Float32Array([0.8, 0.6]),
          new Float32Array([0, 1]),
        ]),
        bm25Index: { getScoresAsync: async () => [9, 10, 0] } as never,
        chunks,
        topK: 1,
      };
      process.env.MIRU_RANK_FUSION = "linear";
      const linear = await prepareHybridCandidates(options);
      expect(linear.semanticScores.size).toBe(2);
      expect(linear.bm25Scores.size).toBe(2);
      expect(linear.semanticScores.get("b.ts:1:10")).toBeCloseTo(0.8);
      expect(linear.bm25Scores.get("a.ts:1:10")).toBe(9);
      expect(linear.bm25Scores.has("c.ts:1:10")).toBe(false);
      expect(await hybridSearch(options)).toEqual(rankHybridCandidates(linear, options));
      process.env.MIRU_RANK_FUSION = "rrf";
      const rrf = await prepareHybridCandidates(options);
      expect(rrf.semanticScores.size).toBe(1);
      expect(rrf.bm25Scores.size).toBe(1);
      expect(rrf.semanticScores.has("b.ts:1:10")).toBe(false);
      expect(rrf.bm25Scores.has("a.ts:1:10")).toBe(false);
    } finally {
      if (previousFusion === undefined) delete process.env.MIRU_RANK_FUSION;
      else process.env.MIRU_RANK_FUSION = previousFusion;
      if (previousDepth === undefined) delete process.env.MIRU_RANK_CANDIDATE_MULTIPLIER;
      else process.env.MIRU_RANK_CANDIDATE_MULTIPLIER = previousDepth;
    }
  });
  test("linear fusion preserves a strong semantic lead over near-tied lexical matches", async () => {
    const previousFusion = process.env.MIRU_RANK_FUSION;
    process.env.MIRU_RANK_FUSION = "linear";
    try {
      const chunks = [chunk("a", "a.ts"), chunk("b", "b.ts"), chunk("c", "c.ts")];
      const results = await hybridSearch({
        query: "example",
        queryVector: new Float32Array([1]),
        embeddings: mockEmbeddings([]),
        semanticIndex: {
          query: () => ({ indices: [0, 1, 2], distances: [0, 0.9, 1] }),
        } as never,
        bm25Index: { getScoresAsync: async () => [9, 10, 1] } as never,
        chunks,
        topK: 3,
        alpha: 0.5,
        rerank: false,
      });
      expect(results.map((r) => r.chunk.file_path)).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(results[0]?.score).toBeCloseTo(0.95);
      expect(results[1]?.score).toBeCloseTo(0.55);
    } finally {
      if (previousFusion === undefined) delete process.env.MIRU_RANK_FUSION;
      else process.env.MIRU_RANK_FUSION = previousFusion;
    }
  });
  test("reducing conceptual-query boosts preserves explicit symbol navigation", async () => {
    const previousFusion = process.env.MIRU_RANK_FUSION;
    const previousScale = process.env.MIRU_RANK_LINEAR_QUERY_BOOST_SCALE;
    process.env.MIRU_RANK_FUSION = "linear";
    process.env.MIRU_RANK_LINEAR_QUERY_BOOST_SCALE = "0";
    try {
      const chunks = [
        chunk("unrelated", "src/unrelated.ts"),
        chunk("export function parseData() {}", "src/parseData.ts"),
      ];
      const results = await hybridSearch({
        query: "parseData",
        queryVector: new Float32Array([1, 0]),
        embeddings: mockEmbeddings([]),
        semanticIndex: new VectorIndex([new Float32Array([1, 0]), new Float32Array([0, 1])]),
        bm25Index: { getScoresAsync: async () => [10, 1] } as never,
        chunks,
        topK: 1,
      });
      expect(results[0]?.chunk.file_path).toBe("src/parseData.ts");
    } finally {
      if (previousFusion === undefined) delete process.env.MIRU_RANK_FUSION;
      else process.env.MIRU_RANK_FUSION = previousFusion;
      if (previousScale === undefined) delete process.env.MIRU_RANK_LINEAR_QUERY_BOOST_SCALE;
      else process.env.MIRU_RANK_LINEAR_QUERY_BOOST_SCALE = previousScale;
    }
  });
  test("returns no results for empty selectors and ignores invalid semantic chunk indices", async () => {
    const emptyBm25 = new BM25Index();
    const semantic = {
      query: () => ({ indices: [3], distances: [0] }),
    } as never;
    const embeddings = mockEmbeddings([]);
    expect(
      await hybridSearch({
        query: "anything",
        queryVector: new Float32Array(4),
        embeddings,
        semanticIndex: semantic,
        bm25Index: emptyBm25,
        chunks: [],
        topK: 5,
        selector: [],
      }),
    ).toEqual([]);
    const result = await hybridSearch({
      query: "anything",
      queryVector: new Float32Array(4),
      embeddings,
      semanticIndex: semantic,
      bm25Index: emptyBm25,
      chunks: [],
      topK: 5,
      alpha: 1,
      rerank: false,
    });
    expect(result).toEqual([]);
  });

  test("semantic-only retrieval returns nearest chunk", async () => {
    const chunks = [chunk("0", "src/auth.ts"), chunk("1", "src/db.ts"), chunk("2", "src/util.ts")];
    const vectors = [unitVector(4, 0, 1), unitVector(4, 1, 1), unitVector(4, 2, 1)];
    const bm25 = new BM25Index();
    bm25.index(chunks.map((c) => [c.content]));
    const semantic = new VectorIndex(vectors);
    const embeddings = mockEmbeddings(vectors);

    const results = await hybridSearch({
      query: "0",
      embeddings,
      semanticIndex: semantic,
      bm25Index: bm25,
      chunks,
      topK: 1,
      alpha: 1,
      rerank: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.file_path).toBe("src/auth.ts");
  });

  test("BM25-only retrieval ranks lexical match first", async () => {
    const chunks = [
      chunk("database migration schema", "src/db.ts"),
      chunk("auth middleware token", "src/auth.ts"),
    ];
    const vectors = [unitVector(4, 0, 1), unitVector(4, 1, 1)];
    const bm25 = new BM25Index();
    bm25.index(chunks.map((c) => c.content.split(/\s+/)));
    const semantic = new VectorIndex(vectors);
    const embeddings = mockEmbeddings(vectors);

    const results = await hybridSearch({
      query: "auth token",
      embeddings,
      semanticIndex: semantic,
      bm25Index: bm25,
      chunks,
      topK: 1,
      alpha: 0,
      rerank: false,
    });

    expect(results[0]?.chunk.file_path).toBe("src/auth.ts");
  });
});
