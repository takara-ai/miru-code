/**
 * Credential-free coverage for the indexing pipeline batching changes:
 * full API batches, overlapped BM25, and default batch size.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { resolveEmbeddingBatchSize, resolveMaxEmbedChars } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { hybridSearch } from "../src/search.ts";
import { tokenize } from "../src/tokens.ts";

function recordingEmbeddings(dim = 4): EmbeddingBackend & {
  requestSizes: number[];
} {
  const requestSizes: number[] = [];
  return {
    model: "mock-pipeline",
    dimensions: dim,
    requestSizes,
    async embedInputs(texts: string[]) {
      requestSizes.push(texts.length);
      return texts.map((_, i) => {
        const v = new Float32Array(dim);
        v[i % dim] = 1;
        return v;
      });
    },
    async embedDocuments(texts: string[]) {
      // Should not be used when embedInputs is present.
      requestSizes.push(-texts.length);
      return texts.map(() => new Float32Array(dim));
    },
    async embedQuery() {
      return new Float32Array(dim);
    },
  };
}

async function writeManyShortTsFiles(root: string, count: number): Promise<void> {
  const src = join(root, "src");
  await mkdir(src, { recursive: true });
  for (let i = 0; i < count; i++) {
    // Short files → one chunk / one window each (under 1300 chars).
    await writeFile(
      join(src, `f${i}.ts`),
      `export function handler${i}() {\n  return ${i};\n}\n`,
      "utf-8",
    );
  }
}

describe("resolveEmbeddingBatchSize defaults", () => {
  const prevBatch = process.env.MIRU_EMBEDDING_BATCH_SIZE;
  const prevOpenAi = process.env.OPENAI_EMBEDDING_BATCH_SIZE;
  const prevPipeline = process.env.MIRU_PIPELINE_EMBED_BATCH;
  const prevChars = process.env.MIRU_MAX_EMBED_CHARS;

  afterEach(() => {
    if (prevBatch === undefined) delete process.env.MIRU_EMBEDDING_BATCH_SIZE;
    else process.env.MIRU_EMBEDDING_BATCH_SIZE = prevBatch;
    if (prevOpenAi === undefined) delete process.env.OPENAI_EMBEDDING_BATCH_SIZE;
    else process.env.OPENAI_EMBEDDING_BATCH_SIZE = prevOpenAi;
    if (prevPipeline === undefined) delete process.env.MIRU_PIPELINE_EMBED_BATCH;
    else process.env.MIRU_PIPELINE_EMBED_BATCH = prevPipeline;
    if (prevChars === undefined) delete process.env.MIRU_MAX_EMBED_CHARS;
    else process.env.MIRU_MAX_EMBED_CHARS = prevChars;
  });

  test("default batch size is 360", () => {
    delete process.env.MIRU_EMBEDDING_BATCH_SIZE;
    delete process.env.OPENAI_EMBEDDING_BATCH_SIZE;
    expect(resolveEmbeddingBatchSize()).toBe(360);
  });

  test("default max embed chars stays 1300 for recall parity", () => {
    delete process.env.MIRU_MAX_EMBED_CHARS;
    expect(resolveMaxEmbedChars()).toBe(1300);
  });

  test("MIRU_EMBEDDING_BATCH_SIZE overrides default", () => {
    process.env.MIRU_EMBEDDING_BATCH_SIZE = "120";
    expect(resolveEmbeddingBatchSize()).toBe(120);
  });
});

describe("BM25Index.addDocument", () => {
  test("incremental addDocument matches bulk index() scores", () => {
    const docs = [
      ["auth", "middleware", "token"],
      ["database", "migration", "schema"],
      ["auth", "token", "refresh"],
    ];
    const bulk = new BM25Index();
    bulk.index(docs);

    const incremental = new BM25Index();
    for (const doc of docs) {
      incremental.addDocument(doc);
    }

    const query = ["auth", "token"];
    expect(incremental.getScores(query)).toEqual(bulk.getScores(query));
  });

  test("toJSON/fromJSON round-trip preserves incremental index", () => {
    const index = new BM25Index();
    index.addDocument(["alpha", "beta"]);
    index.addDocument(["alpha", "gamma"]);
    const restored = BM25Index.fromJSON(index.toJSON());
    expect(restored.getScores(["alpha"])).toEqual(index.getScores(["alpha"]));
    expect(restored.getScores(["gamma"])[1]).toBeGreaterThan(0);
  });
});

describe("createIndexFromPath window batching (no credentials)", () => {
  test("embedInputs receives full batches except the final remainder", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-pipeline-batch-"));
    const prevBatch = process.env.MIRU_EMBEDDING_BATCH_SIZE;
    const prevInflight = process.env.MIRU_PIPELINE_EMBED_INFLIGHT;
    const prevPipelineBatch = process.env.MIRU_PIPELINE_EMBED_BATCH;
    try {
      // 50 short files → ~50 windows. With batch 16: three full + remainder.
      process.env.MIRU_EMBEDDING_BATCH_SIZE = "16";
      process.env.MIRU_PIPELINE_EMBED_INFLIGHT = "2";
      delete process.env.MIRU_PIPELINE_EMBED_BATCH;

      await writeManyShortTsFiles(root, 50);
      const embeddings = recordingEmbeddings();
      const { chunks, bm25, semantic } = await createIndexFromPath(
        root,
        embeddings,
        ["code"],
        root,
      );

      expect(chunks.length).toBeGreaterThanOrEqual(50);
      expect(embeddings.requestSizes.length).toBeGreaterThan(1);
      expect(embeddings.requestSizes.every((n) => n > 0)).toBe(true);

      const full = embeddings.requestSizes.slice(0, -1);
      const last = embeddings.requestSizes.at(-1) ?? 0;
      expect(full.every((n) => n === 16)).toBe(true);
      expect(last).toBeGreaterThan(0);
      expect(last).toBeLessThanOrEqual(16);
      expect(embeddings.requestSizes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
        chunks.length,
      );

      // BM25 was built (overlapped) and is searchable.
      const scores = bm25.getScores(tokenize("handler0"));
      expect(scores.some((s) => s > 0)).toBe(true);
      expect(chunks.some((c) => c.content.includes("handler0"))).toBe(true);

      const results = await hybridSearch({
        query: "handler0",
        embeddings,
        semanticIndex: semantic,
        bm25Index: bm25,
        chunks,
        topK: 5,
        alpha: 0,
        rerank: false,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.chunk.content.includes("handler0"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (prevBatch === undefined) delete process.env.MIRU_EMBEDDING_BATCH_SIZE;
      else process.env.MIRU_EMBEDDING_BATCH_SIZE = prevBatch;
      if (prevInflight === undefined) delete process.env.MIRU_PIPELINE_EMBED_INFLIGHT;
      else process.env.MIRU_PIPELINE_EMBED_INFLIGHT = prevInflight;
      if (prevPipelineBatch === undefined) delete process.env.MIRU_PIPELINE_EMBED_BATCH;
      else process.env.MIRU_PIPELINE_EMBED_BATCH = prevPipelineBatch;
    }
  });

  test("falls back to embedDocuments when embedInputs is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-pipeline-fallback-"));
    const prevBatch = process.env.MIRU_EMBEDDING_BATCH_SIZE;
    try {
      process.env.MIRU_EMBEDDING_BATCH_SIZE = "8";
      await writeManyShortTsFiles(root, 12);

      const requestSizes: number[] = [];
      const embeddings: EmbeddingBackend = {
        model: "mock-fallback",
        dimensions: 2,
        async embedDocuments(texts: string[]) {
          requestSizes.push(texts.length);
          return texts.map(() => new Float32Array([1, 0]));
        },
        async embedQuery() {
          return new Float32Array([1, 0]);
        },
      };

      const { chunks } = await createIndexFromPath(root, embeddings, ["code"], root);
      expect(chunks.length).toBeGreaterThanOrEqual(12);
      expect(requestSizes.length).toBeGreaterThan(0);
      const full = requestSizes.slice(0, -1);
      expect(full.every((n) => n === 8)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (prevBatch === undefined) delete process.env.MIRU_EMBEDDING_BATCH_SIZE;
      else process.env.MIRU_EMBEDDING_BATCH_SIZE = prevBatch;
    }
  });

  test("profile reports pipeline batch size from embedding batch env", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-pipeline-profile-"));
    const prevBatch = process.env.MIRU_EMBEDDING_BATCH_SIZE;
    const prevProfile = process.env.MIRU_PROFILE;
    try {
      process.env.MIRU_EMBEDDING_BATCH_SIZE = "24";
      process.env.MIRU_PROFILE = "1";
      await writeManyShortTsFiles(root, 30);

      const lines: string[] = [];
      const origError = console.error;
      console.error = (msg: unknown) => {
        lines.push(String(msg));
      };
      try {
        await createIndexFromPath(root, recordingEmbeddings(), ["code"], root);
      } finally {
        console.error = origError;
      }

      const line = lines.find((entry) => entry.includes('"profile":"index_build"'));
      expect(line).toBeDefined();
      if (!line) {
        throw new Error("Expected index_build profile line");
      }
      const profile = JSON.parse(line) as {
        pipeline: { embed_batch_size: number; max_embed_chars: number };
      };
      expect(profile.pipeline.embed_batch_size).toBe(24);
      expect(profile.pipeline.max_embed_chars).toBe(1300);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (prevBatch === undefined) delete process.env.MIRU_EMBEDDING_BATCH_SIZE;
      else process.env.MIRU_EMBEDDING_BATCH_SIZE = prevBatch;
      if (prevProfile === undefined) delete process.env.MIRU_PROFILE;
      else process.env.MIRU_PROFILE = prevProfile;
    }
  });
});
