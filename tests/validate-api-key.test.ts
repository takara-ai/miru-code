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
      model: "ds1-miru-int8",
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
      model: "ds1-miru-int8",
      dimensions: 256,
    });
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain("Not authorized");
    expect(result.message).toContain("token balance");
    expect(result.message).not.toContain("unauthorized");
  });

  test("rejects empty embedding payloads", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await validateEmbeddingApiKey({
      apiKey: "good-key",
      baseUrl: "https://example.test/v1",
      model: "ds1-miru-int8",
      dimensions: 256,
    });
    expect(result.valid).toBe(false);
    expect(result.message).toContain("empty");
  });

  test("ignores SageMaker env when choosing the Takara validation model", async () => {
    const prevArn = process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN =
      "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-2";
    let requestedModel = "";
    globalThis.fetch = (async (_input, init) => {
      requestedModel = (JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "";
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 256 }, () => 0.1) }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await validateEmbeddingApiKey({
        apiKey: "good-key",
        baseUrl: "https://example.test/v1",
        dimensions: 256,
      });
      expect(result.valid).toBe(true);
      expect(requestedModel.startsWith("sagemaker:")).toBe(false);
    } finally {
      if (prevArn === undefined) delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
      else process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = prevArn;
    }
  });
});
