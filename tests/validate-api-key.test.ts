import { afterEach, describe, expect, test } from "bun:test";
import { validateEmbeddingApiKey } from "../src/embeddings/validate.ts";
import { fake } from "./helpers/fake-credentials.ts";

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
      apiKey: fake("good-key"),
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
      apiKey: fake("good-key"),
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
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      requestedModel =
        (JSON.parse(String(args[1]?.body ?? "{}")) as { model?: string }).model ?? "";
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 256 }, () => 0.1) }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await validateEmbeddingApiKey({
        apiKey: fake("good-key"),
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

  test("reports connection, authorization, response text, and invalid payload failures", async () => {
    const options = {
      apiKey: "key",
      baseUrl: "https://example.test/v1/",
      model: "test",
      dimensions: 3,
    };
    const disconnected = await validateEmbeddingApiKey(options, async () => {
      throw new Error("offline");
    });
    expect(disconnected.message).toContain(
      "Could not reach embedding API at https://example.test/v1: offline",
    );

    const forbidden = await validateEmbeddingApiKey(
      options,
      async () => new Response("private", { status: 403 }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.message).toContain("Not authorized");

    const serverError = await validateEmbeddingApiKey(
      options,
      async () => new Response("x".repeat(300), { status: 500 }),
    );
    expect(serverError.message.length).toBeLessThan(250);
    expect(serverError.message).toStartWith("Embedding API returned 500:");

    const invalidJson = await validateEmbeddingApiKey(
      options,
      async () => new Response("{", { status: 200 }),
    );
    expect(invalidJson.message).toContain("invalid JSON");

    const wrongDimensions = await validateEmbeddingApiKey(options, async () =>
      Response.json({ data: [{ embedding: [1, 2] }] }),
    );
    expect(wrongDimensions.message).toContain("Expected 3 embedding dimensions, got 2");
  });

  test("handles missing embeddings and non-Error fetch rejections", async () => {
    const options = { apiKey: "key", baseUrl: "https://example.test", model: "test" };
    const missing = await validateEmbeddingApiKey(options, async () => Response.json({ data: [] }));
    expect(missing.message).toContain("empty response");

    const rejected = await validateEmbeddingApiKey(options, async () => {
      throw "offline";
    });
    expect(rejected.message).toContain(": offline");
  });
});
