import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dequantizeEmbedding,
  OpenAIEmbeddingBackend,
  sageMakerModelId,
  sanitizeEmbeddingInput,
} from "../src/embeddings/openai.ts";
import { fake } from "./helpers/fake-credentials.ts";

async function withApiEnvironment(run: (credentialsDir: string) => Promise<void>): Promise<void> {
  const credentialsDir = await mkdtemp(join(tmpdir(), "miru-openai-client-"));
  const previous = {
    key: process.env.TAKARA_API_KEY,
    dir: process.env.MIRU_CREDENTIALS_DIR,
    base: process.env.MIRU_OPENAI_BASE_URL,
  };
  process.env.TAKARA_API_KEY = fake("test-api-key");
  process.env.MIRU_CREDENTIALS_DIR = credentialsDir;
  process.env.MIRU_OPENAI_BASE_URL = "https://embedding.example.test/v1";
  try {
    await run(credentialsDir);
  } finally {
    await rm(credentialsDir, { recursive: true, force: true });
    for (const [key, value] of [
      ["TAKARA_API_KEY", previous.key],
      ["MIRU_CREDENTIALS_DIR", previous.dir],
      ["MIRU_OPENAI_BASE_URL", previous.base],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function oneHot(dim: number, index: number): number[] {
  const vec = Array.from({ length: dim }, () => 0);
  vec[index] = 1;
  return vec;
}

describe("sanitizeEmbeddingInput", () => {
  test("replaces lone surrogates so JSON.stringify is valid", () => {
    const loneHigh = "\uD800";
    const loneLow = "\uDC00";
    const validPair = "\uD83D\uDE00";

    expect(sanitizeEmbeddingInput(loneHigh)).toBe("\uFFFD");
    expect(sanitizeEmbeddingInput(loneLow)).toBe("\uFFFD");
    expect(sanitizeEmbeddingInput(validPair)).toBe(validPair);

    const body = JSON.stringify({ input: [sanitizeEmbeddingInput(loneHigh)] });
    expect(() => JSON.parse(body)).not.toThrow();
  });
});

describe("dequantizeEmbedding", () => {
  test("dequantizes native int8 payloads", () => {
    const vec = dequantizeEmbedding({
      dtype: "i8",
      values: [127, -127, 0],
      scale: 0.01,
      zero_point: 0,
    });
    expect(vec[0]).toBeCloseTo(1.27, 5);
    expect(vec[1]).toBeCloseTo(-1.27, 5);
    expect(vec[2]).toBeCloseTo(0, 5);
  });

  test("passes float arrays through unchanged", () => {
    const vec = dequantizeEmbedding([0.5, -0.25]);
    expect(vec[0]).toBeCloseTo(0.5, 5);
    expect(vec[1]).toBeCloseTo(-0.25, 5);
  });
});

describe("OpenAIEmbeddingBackend int8 responses", () => {
  test("embedDocuments accepts native int8 embedding objects", async () => {
    const backend = new OpenAIEmbeddingBackend({
      model: "ds1-miru-int8",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: {
                dtype: "i8" as const,
                values: index === 0 ? [127, 0, 0] : [0, 127, 0],
                scale: 1 / 127,
                zero_point: 0,
              },
            })),
          };
        },
      },
    });

    const vectors = await backend.embedDocuments(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.[0]).toBeCloseTo(1, 3);
    expect(vectors[1]?.[1]).toBeCloseTo(1, 3);
  });
});

describe("OpenAIEmbeddingBackend batching", () => {
  test("returns empty vectors without calling the API for empty documents", async () => {
    let requests = 0;
    const backend = new OpenAIEmbeddingBackend({
      model: "empty-documents",
      client: {
        async createEmbeddings() {
          requests++;
          return { data: [] };
        },
      },
    });
    expect(await backend.embedInputs([])).toEqual([]);
    const missingText = new Proxy(["placeholder"], {
      get(target, property, receiver) {
        return property === "0" ? undefined : Reflect.get(target, property, receiver);
      },
    });
    expect(await backend.embedDocuments(missingText)).toEqual([new Float32Array(0)]);
    expect(requests).toBe(0);
  });

  test("embedQuery delegates to document embedding and SageMaker model IDs are endpoint-scoped", async () => {
    const backend = new OpenAIEmbeddingBackend({
      model: "query-model",
      dimensions: 2,
      client: {
        async createEmbeddings(input) {
          expect(input).toEqual(["query text"]);
          return { data: [{ index: 0, embedding: [0.25, 0.75] }] };
        },
      },
    });
    const vector = await backend.embedQuery("query text");
    expect(vector[0]).toBeCloseTo(0.31622777, 6);
    expect(vector[1]).toBeCloseTo(0.9486833, 6);
    expect(sageMakerModelId("prod-endpoint")).toBe("sagemaker:prod-endpoint");
  });

  test("default HTTP client sends authorized requests and tracks/reset stats", async () => {
    await withApiEnvironment(async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const backend = new OpenAIEmbeddingBackend({
        model: "test-http-model",
        dimensions: 2,
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init });
          return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
        },
      });

      const [vector] = await backend.embedInputs(["hello"]);
      expect(vector?.[0]).toBe(1);
      expect(requests[0]?.url).toBe("https://embedding.example.test/v1/embeddings");
      expect(requests[0]?.init?.method).toBe("POST");
      expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-api-key",
      );
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        model: "test-http-model",
        input: ["hello"],
        dimensions: 2,
      });
      expect(backend.getStats()).toMatchObject({ requests: 1, inputItems: 1, inputChars: 5 });
      backend.resetStats();
      expect(backend.getStats()).toEqual({
        requests: 0,
        retries: 0,
        payloadTooLarge: 0,
        errors: 0,
        inputItems: 0,
        inputChars: 0,
        totalRttMs: 0,
        maxRttMs: 0,
      });
    });
  });

  test("default HTTP client turns non-success and malformed payloads into errors", async () => {
    await withApiEnvironment(async () => {
      const denied = new OpenAIEmbeddingBackend({
        model: "test-http-model",
        fetchImpl: async () => new Response("forbidden", { status: 403 }),
      });
      await expect(denied.embedInputs(["hello"])).rejects.toThrow("Not authorized");

      const malformed = new OpenAIEmbeddingBackend({
        model: "test-http-model",
        fetchImpl: async () => Response.json({ nope: true }),
      });
      await expect(malformed.embedInputs(["hello"])).rejects.toThrow("invalid payload");
    });
  });

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

  test("embedInputs sends exactly the provided batch size", async () => {
    const requestSizes: number[] = [];
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 4,
      batchSize: 120,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          requestSizes.push(texts.length);
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: oneHot(4, index % 4),
            })),
          };
        },
      },
    });

    await backend.embedInputs(Array.from({ length: 120 }, (_, i) => `w${i}`));
    expect(requestSizes).toEqual([120]);
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
