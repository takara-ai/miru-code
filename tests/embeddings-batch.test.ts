import { describe, expect, test } from "bun:test";
import { OpenAIEmbeddingBackend } from "../src/embeddings/openai.ts";

function oneHot(dim: number, index: number): number[] {
  const vec = Array.from({ length: dim }, () => 0);
  vec[index] = 1;
  return vec;
}

describe("OpenAIEmbeddingBackend batching", () => {
  test("embedDocuments batches windows and assigns vectors to correct documents", async () => {
    const requestSizes: number[] = [];
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 20,
      batchSize: 32,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          requestSizes.push(texts.length);
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: oneHot(20, index),
            })),
          };
        },
      },
    });

    const texts = Array.from({ length: 20 }, (_, i) => `chunk ${i} `.repeat(80));
    const vectors = await backend.embedDocuments(texts);

    expect(vectors).toHaveLength(20);
    expect(requestSizes).toEqual([20]);
    expect(requestSizes.every((n) => n <= 32)).toBe(true);

    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i];
      expect(vec).toBeDefined();
      expect(vec?.[i]).toBeCloseTo(1, 5);
      const otherPeak = vec?.findIndex((value, dim) => dim !== i && Math.abs(value) > 0.01);
      expect(otherPeak).toBe(-1);
    }
  });

  test("rejects duplicate embedding indices from API", async () => {
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          return {
            data: texts.map(() => ({
              index: 0,
              embedding: [1, 0, 0],
            })),
          };
        },
      },
    });

    await expect(backend.embedDocuments(["a", "b"])).rejects.toThrow(/unique indices/);
  });

  test("embedDocuments pools multiple windows for one long text", async () => {
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 100,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          expect(texts.length).toBeGreaterThan(1);
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: [index === 0 ? 1 : 0, index === 1 ? 1 : 0, 0],
            })),
          };
        },
      },
    });

    const [vec] = await backend.embedDocuments(["x".repeat(250)]);
    expect(vec.length).toBe(3);
    expect(vec[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(vec[1]).toBeCloseTo(Math.SQRT1_2, 3);
  });
});
