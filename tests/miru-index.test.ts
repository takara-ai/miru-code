import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIndexCachePath } from "../src/cache.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
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

describe("MiruIndex related chunks", () => {
  test("excludes the source chunk and scopes neighbors to the same language", async () => {
    const source = {
      content: "source",
      file_path: "src/a.ts",
      start_line: 1,
      end_line: 2,
      language: "typescript",
    };
    const neighbor = {
      content: "neighbor",
      file_path: "src/b.ts",
      start_line: 3,
      end_line: 4,
      language: "typescript",
    };
    let requestedTopK = 0;
    let requestedSelector: readonly number[] | undefined;
    const index = new MiruIndex({
      embeddings: {
        model: "test-model",
        dimensions: 1,
        embedDocuments: async () => [],
        embedQuery: async () => new Float32Array([0]),
      },
      bm25Index: {} as BM25Index,
      semanticIndex: {
        size: 2,
        dimensions: 1,
        memoryBytes: () => 0,
        query: (_vector, topK, selector) => {
          requestedTopK = topK;
          requestedSelector = selector;
          return { indices: [0, 1], distances: [0, 0.2] };
        },
      },
      chunks: [source, neighbor],
      embeddingModel: "test-model",
    });
    const results = await index.findRelated({ chunk: source, score: 1 }, 1);
    expect(results).toEqual([{ chunk: neighbor, score: 0.8 }]);
    expect(requestedTopK).toBe(2);
    expect(requestedSelector).toEqual([0, 1]);

    const noLanguage = { ...source, language: null };
    const allLanguages = await index.findRelated(noLanguage, 0);
    expect(allLanguages).toEqual([]);
    expect(requestedSelector).toBeUndefined();
  });
});

describe("MiruIndex search and locate", () => {
  test("applies file filters to search and finds exact literals in indexed chunks", async () => {
    const chunks = [
      {
        content: "alpha exact literal",
        file_path: "src/a.ts",
        start_line: 1,
        end_line: 1,
        language: "typescript",
      },
      {
        content: "alpha other",
        file_path: "docs/b.md",
        start_line: 1,
        end_line: 1,
        language: "markdown",
      },
    ];
    const bm25 = new BM25Index();
    bm25.index(chunks.map((entry) => entry.content.split(" ")));
    const vectors = new VectorIndex([new Float32Array([1]), new Float32Array([0.5])]);
    const index = new MiruIndex({
      embeddings: {
        model: "offline",
        dimensions: 1,
        embedDocuments: async () => [],
        embedQuery: async () => new Float32Array([1]),
      },
      bm25Index: bm25,
      semanticIndex: vectors,
      chunks,
      embeddingModel: "offline",
      content: ["code", "docs"],
    });

    expect(index.chunks).toEqual(chunks);
    expect(index.root).toBeNull();
    expect(index.contentTypes).toEqual(["code", "docs"]);
    expect(index.loadedFromDisk).toBe(false);
    expect(index.getStoredFileMtimes()).toEqual(new Map());

    const result = await index.search({
      query: "alpha",
      topK: 2,
      alpha: 0,
      include: ["src/**"],
      rerank: false,
    });
    expect(result.map((hit) => hit.chunk.file_path)).toEqual(["src/a.ts"]);
    const intersection = await index.search({
      query: "alpha",
      topK: 2,
      alpha: 0,
      filterLanguages: ["typescript"],
      include: ["src/**", "docs/**"],
      rerank: false,
    });
    expect(intersection.map((hit) => hit.chunk.file_path)).toEqual(["src/a.ts"]);
    expect(index.locateLiteral("exact literal", { mode: "count" }).n).toBe(1);
    expect(index.locateLiteral("absent").n).toBe(0);
  });
});

test("saves MiruIndex bundles with current file mtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-index-save-"));
  const output = join(root, "bundle");
  const source = join(root, "src", "a.ts");
  await Bun.write(source, "export const value = 1;\n");
  const index = new MiruIndex({
    embeddings: {
      model: "offline",
      dimensions: 1,
      embedDocuments: async () => [],
      embedQuery: async () => new Float32Array([1]),
    },
    bm25Index: new BM25Index(),
    semanticIndex: new VectorIndex([new Float32Array([1]), new Float32Array([0])]),
    chunks: [
      {
        content: "value",
        file_path: "src/a.ts",
        start_line: 1,
        end_line: 1,
        language: "typescript",
      },
      {
        content: "missing",
        file_path: "src/missing.ts",
        start_line: 1,
        end_line: 1,
        language: "typescript",
      },
    ],
    embeddingModel: "offline",
    root,
  });
  try {
    await index.save(output);
    expect(index.getStoredFileMtimes().has("src/a.ts")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
