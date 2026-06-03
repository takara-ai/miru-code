import { afterEach, describe, expect, test } from "bun:test";
import { validateEmbeddingApiKey } from "../src/embeddings/validate.ts";

describe("validateEmbeddingApiKey", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("accepts a successful embedding response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 256 }, () => 0.1) }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await validateEmbeddingApiKey({
      apiKey: "good-key",
      baseUrl: "https://example.test/v1",
      model: "ds1-potion-code-16m",
      dimensions: 256,
    });
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
  });

  test("rejects unauthorized responses", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const result = await validateEmbeddingApiKey({
      apiKey: "bad-key",
      baseUrl: "https://example.test/v1",
      model: "ds1-potion-code-16m",
      dimensions: 256,
    });
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain("Invalid API key");
  });

  test("rejects empty embedding payloads", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await validateEmbeddingApiKey({
      apiKey: "good-key",
      baseUrl: "https://example.test/v1",
      model: "ds1-potion-code-16m",
      dimensions: 256,
    });
    expect(result.valid).toBe(false);
    expect(result.message).toContain("empty");
  });
});
