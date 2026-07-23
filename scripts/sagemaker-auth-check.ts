/**
 * Smoke test for self-hosted SageMaker embedding mode. Exports of AWS creds are picked up
 * from the environment (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN or
 * AWS_PROFILE) via the AWS SDK's default credential chain — nothing to pass on the CLI for
 * that part. This script only needs the endpoint ARN, then does a real InvokeEndpoint call
 * to confirm auth + the endpoint responds like an embedding model.
 *
 * Usage:
 *   bun run scripts/sagemaker-auth-check.ts --arn arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-endpoint
 *   bun run scripts/sagemaker-auth-check.ts --arn <arn> --region us-west-2 --text "hello world"
 */
import { embeddingDimensions } from "../src/embeddings/openai.ts";
import {
  createSageMakerClient,
  parseSageMakerEndpointArn,
  type SageMakerEmbeddingConfig,
} from "../src/embeddings/sagemaker.ts";

function usageError(message: string): never {
  console.error(`Error: ${message}`);
  console.error("");
  console.error(
    "Usage: bun run scripts/sagemaker-auth-check.ts --arn <endpoint-arn> [--region <region>] [--text <sample>]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let arn: string | undefined;
let regionOverride: string | undefined;
let text = "miru sagemaker auth check";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--arn" && args[i + 1]) {
    arn = args[++i];
  } else if (arg === "--region" && args[i + 1]) {
    regionOverride = args[++i];
  } else if (arg === "--text" && args[i + 1]) {
    text = args[++i] as string;
  }
}

if (!arn) {
  usageError("--arn is required");
}

function describeCredentialEnv(): string {
  const bits: string[] = [];
  if (process.env.AWS_PROFILE) {
    bits.push(`AWS_PROFILE=${process.env.AWS_PROFILE}`);
  }
  if (process.env.AWS_ACCESS_KEY_ID) {
    bits.push(`AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID.slice(0, 4)}…`);
  }
  if (process.env.AWS_SESSION_TOKEN) {
    bits.push("AWS_SESSION_TOKEN=<set>");
  }
  return bits.length > 0
    ? bits.join(", ")
    : "(none in env — relying on IMDS/container role, if any)";
}

let parsed: ReturnType<typeof parseSageMakerEndpointArn>;
try {
  parsed = parseSageMakerEndpointArn(arn);
} catch (err) {
  usageError(err instanceof Error ? err.message : String(err));
}

const config: SageMakerEmbeddingConfig = {
  endpointName: parsed.endpointName,
  region: regionOverride ?? parsed.region,
  normalize: true,
  truncate: true,
  truncationDirection: "Right",
};

console.log(`Endpoint:    ${config.endpointName}`);
console.log(`Region:      ${config.region}`);
console.log(`Account:     ${parsed.accountId}`);
console.log(`Credentials: ${describeCredentialEnv()}`);
console.log("");
console.log("Invoking endpoint…");

const started = performance.now();
try {
  const client = createSageMakerClient(config);
  const response = await client.createEmbeddings(text, "sagemaker-auth-check");
  const elapsed = (performance.now() - started).toFixed(0);

  const first = response.data[0]?.embedding;
  const dims = first ? embeddingDimensions(first) : 0;

  console.log(`OK — ${response.data.length} embedding(s), ${dims} dims, ${elapsed}ms`);
  process.exit(0);
} catch (err) {
  const elapsed = (performance.now() - started).toFixed(0);
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number }).status;

  console.error(`FAILED after ${elapsed}ms${status ? ` (status ${status})` : ""}: ${message}`);
  if (status === 403) {
    console.error("");
    console.error("Check that the exported AWS credentials belong to an identity with");
    console.error(`sagemaker:InvokeEndpoint on ${arn}.`);
  } else if (status === 424) {
    console.error("");
    console.error("The endpoint responded, but the deployed model isn't an embedding model.");
  }
  process.exit(1);
}
