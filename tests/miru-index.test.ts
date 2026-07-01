import { describe, expect, test } from "bun:test";
import { findIndexCachePath } from "../src/cache.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import type { BM25Index } from "../src/index/bm25.ts";
import type { SemanticIndex } from "../src/index/semantic-index.ts";
import { MiruIndex } from "../src/miru-index.ts";

function makeIndex(loadedFromDisk: boolean): MiruIndex {
  return new MiruIndex({
    embeddings: {
      model: "test-model",
      dimensions: 1,
      embedDocuments: async () => [],
      embedQuery: async () => new Float32Array([0]),
    } satisfies EmbeddingBackend,
    bm25Index: {} as BM25Index,
    semanticIndex: {} as SemanticIndex,
    chunks: [],
    embeddingModel: "test-model",
    loadedFromDisk,
  });
}

describe("MiruIndex cache persistence", () => {
  test("saveToCache skips an unchanged index loaded from disk by default", async () => {
    const index = makeIndex(true);
    const writes: string[] = [];
    index.save = async (path: string) => {
      writes.push(path);
    };

    await index.saveToCache("/repo");

    expect(writes).toEqual([]);
  });

  test("saveToCache writes a freshly built index to the default cache", async () => {
    const index = makeIndex(false);
    const writes: string[] = [];
    index.save = async (path: string) => {
      writes.push(path);
    };

    await index.saveToCache("/repo");

    expect(writes).toEqual([findIndexCachePath("/repo")]);
  });

  test("saveToCache force-writes an index that was loaded from disk", async () => {
    const index = makeIndex(true);
    const writes: string[] = [];
    index.save = async (path: string) => {
      writes.push(path);
    };

    await index.saveToCache("/repo", { force: true });

    expect(writes).toEqual([findIndexCachePath("/repo")]);
  });
});
