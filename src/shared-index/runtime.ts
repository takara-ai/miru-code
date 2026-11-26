import { SQL } from "bun";
import { getEmbeddingBackend } from "../embeddings/openai.ts";
import { resolveSageMakerConfig } from "../embeddings/sagemaker.ts";
import { SharedIndex } from "./store.ts";

export function connectSharedDatabase(
  databaseUrl: string,
  options: { local?: boolean; ca?: string } = {},
) {
  const parsed = new URL(databaseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    (parsed.searchParams.get("sslmode") !== "verify-full" && !(options.local && loopback))
  ) {
    throw new Error("Use a CockroachDB PostgreSQL URL with sslmode=verify-full.");
  }
  return new SQL({
    url: databaseUrl,
    max: 4,
    connectionTimeout: 10,
    idleTimeout: 30,
    ...(options.ca ? { tls: { ca: options.ca, rejectUnauthorized: true } } : {}),
  });
}

export function openSharedIndex(databaseUrl: string, options?: { local?: boolean; ca?: string }) {
  if (!resolveSageMakerConfig()) throw new Error("A ds1-code SageMaker endpoint is required.");
  const model = process.env.MIRU_SHARED_MODEL_KEY?.trim();
  if (!model) throw new Error("Set an immutable MIRU_SHARED_MODEL_KEY for this model deployment.");
  return new SharedIndex(connectSharedDatabase(databaseUrl, options), getEmbeddingBackend(), model);
}
