import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runProbe(
  source: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "-e", source],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MIRU_SAGEMAKER_ENDPOINT_ARN: "",
      MIRU_SAGEMAKER_ENDPOINT_NAME: "",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const AWS_SDK_PROBE = `
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const id = require.resolve("@aws-sdk/client-sagemaker-runtime");
console.log(require.cache[id] ? "AWS_SDK=loaded" : "AWS_SDK=absent");
`;

describe("SageMaker AWS SDK lazy load", () => {
  test("importing openai/sagemaker helpers does not load the AWS SDK", async () => {
    const { stdout, stderr, exitCode } = await runProbe(`
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_NAME;
      // MCP/CLI import graph: openai pulls sagemaker helpers. Neither should load AWS SDK.
      const { resolveEmbeddingModel } = await import("./src/embeddings/openai.ts");
      const {
        parseSageMakerEndpointArn,
        resolveSageMakerConfig,
        createSageMakerClient,
        isSageMakerConfigured,
      } = await import("./src/embeddings/sagemaker.ts");

      parseSageMakerEndpointArn("arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test");
      if (resolveSageMakerConfig() != null) throw new Error("expected null config");
      if (isSageMakerConfigured()) throw new Error("expected false");
      // Building the client wrapper must stay free of the AWS SDK.
      createSageMakerClient({
        endpointName: "miru-test",
        region: "us-east-1",
        normalize: true,
        truncate: true,
        truncationDirection: "Right",
      });
      resolveEmbeddingModel();
      ${AWS_SDK_PROBE}
    `);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("AWS_SDK=absent");
  });

  test("invoking the SageMaker client loads the AWS SDK", async () => {
    const { stdout, stderr, exitCode } = await runProbe(`
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_NAME;
      const { createSageMakerClient } = await import("./src/embeddings/sagemaker.ts");
      const client = createSageMakerClient({
        endpointName: "miru-test",
        region: "us-east-1",
        normalize: true,
        truncate: true,
        truncationDirection: "Right",
      });
      try {
        await client.createEmbeddings("lazy-load probe", "sagemaker:miru-test");
      } catch {
        // Invoke may fail without real AWS creds/endpoint; import is what matters.
      }
      ${AWS_SDK_PROBE}
    `);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("AWS_SDK=loaded");
  });
});
