import { describe, expect, test } from "bun:test";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { hybridSearch } from "../src/search.ts";
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

describe("hybridSearch", () => {
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
