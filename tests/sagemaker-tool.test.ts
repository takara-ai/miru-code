import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStoredCredentials,
  readStoredCredentials,
  saveStoredCredentials,
} from "../src/credentials.ts";
import type { validateSageMakerConnection } from "../src/embeddings/sagemaker.ts";
import { registerAuthTool } from "../src/mcp/auth-tool.ts";
import { MiruMcpServer } from "../src/mcp/runtime.ts";
import { fake } from "./helpers/fake-credentials.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

const endpointArn = "arn:aws:sagemaker:eu-west-2:123456789012:endpoint/miru";
let previousEnv: NodeJS.ProcessEnv;
let credentialsDir: string;

beforeEach(async () => {
  previousEnv = { ...process.env };
  credentialsDir = await mkdtemp(join(tmpdir(), "miru-sagemaker-tool-"));
  process.env.MIRU_CREDENTIALS_DIR = credentialsDir;
  delete process.env.MIRU_PLUGIN_SAGEMAKER_ENDPOINT_ARN;
  delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  await saveStoredCredentials(fake("existing-api-key"));
});

afterEach(async () => {
  process.env = previousEnv;
  await rm(credentialsDir, { recursive: true, force: true });
});

async function configure(
  validateConnection: typeof validateSageMakerConnection,
  args: object = { endpoint_arn: endpointArn, aws_profile: "miru-team" },
) {
  let invalidations = 0;
  const server = new MiruMcpServer({ name: "miru", version: "test" });
  registerAuthTool(server, {
    validateConnection,
    onAuthenticated: () => {
      invalidations++;
    },
  });
  const transport = new MemoryTransport([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "auth", arguments: { action: "sagemaker", ...args } },
    },
  ]);
  await server.connect(transport);
  return {
    response: transport.responseFor(1) as {
      result?: { isError?: boolean; content: Array<{ text: string }> };
      error?: { code: number };
    },
    invalidations,
  };
}

for (const args of [{}, { endpoint_arn: endpointArn }, { aws_profile: "miru-team" }]) {
  test(`requires both SageMaker fields: ${JSON.stringify(args)}`, async () => {
    const before = await readStoredCredentials();
    const { response, invalidations } = await configure(async () => {
      throw new Error("should not contact AWS");
    }, args);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content[0]?.text).toContain("requires endpoint_arn and aws_profile");
    expect(await readStoredCredentials()).toEqual(before);
    expect(invalidations).toBe(0);
  });
}

for (const action of [undefined, "start", "check"]) {
  test(`rejects SageMaker fields without the SageMaker action: ${action}`, async () => {
    const { response, invalidations } = await configure(
      async () => {
        throw new Error("should not contact AWS");
      },
      { action, endpoint_arn: endpointArn, aws_profile: "miru-team" },
    );
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content[0]?.text).toContain('Use action "sagemaker"');
    expect(invalidations).toBe(0);
  });
}

for (const valid of [true, false]) {
  test(`${valid ? "clears" : "preserves"} a pending device login after SageMaker validation ${valid ? "succeeds" : "fails"}`, async () => {
    const originalFetch = globalThis.fetch;
    process.env.MIRU_OPEN_BROWSER = "0";
    globalThis.fetch = (async (_input, _init) =>
      new Response(
        JSON.stringify({
          device_code: "pending-device",
          user_code: "TEST-1234",
          verification_uri: "https://example.com/approve",
          expires_in: 600,
          interval: 5,
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const server = new MiruMcpServer({ name: "miru", version: "test" });
      registerAuthTool(server, {
        waitMs: 0,
        validateConnection: async () => ({ valid, message: "validation result" }),
      });
      const transport = new MemoryTransport([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "auth", arguments: {} } },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "auth",
            arguments: { action: "sagemaker", endpoint_arn: endpointArn, aws_profile: "miru-team" },
          },
        },
      ]);
      await server.connect(transport);
      globalThis.fetch = (async (_input, _init) =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
      const check = new MemoryTransport([
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "auth", arguments: { action: "check" } },
        },
      ]);
      await server.connect(check);
      const response = check.responseFor(3) as { result: { content: Array<{ text: string }> } };
      expect(response.result.content[0]?.text).toContain(
        valid ? "No device login is pending" : "Still waiting for approval",
      );
      expect((await readStoredCredentials())?.kind).toBe(valid ? "sagemaker" : "api_key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("switches the running plugin and persists SageMaker in its own credentials directory", async () => {
  const { response, invalidations } = await configure(async (config) => {
    expect(config).toEqual({
      endpointName: "miru",
      region: "eu-west-2",
      profile: "miru-team",
      normalize: true,
      truncate: true,
      truncationDirection: "Right",
    });
    expect((await readStoredCredentials())?.kind).toBe("api_key");
    expect(process.env.TAKARA_API_KEY).toBe(fake("existing-api-key"));
    return { valid: true, message: "ok" };
  });
  expect(response.result?.isError).not.toBe(true);
  expect(response.result?.content[0]?.text).toContain("Miru now embeds via SageMaker");
  expect(invalidations).toBe(1);
  expect(await readStoredCredentials()).toMatchObject({
    kind: "sagemaker",
    endpoint_arn: endpointArn,
    profile: "miru-team",
  });
  expect(process.env.TAKARA_API_KEY).toBeUndefined();
  expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBe(endpointArn);
  expect(process.env.AWS_PROFILE).toBe("miru-team");
  // A fresh MCP process hydrates the saved endpoint and profile.
  delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  delete process.env.AWS_PROFILE;
  await loadStoredCredentials();
  expect(process.env).toMatchObject({
    MIRU_SAGEMAKER_ENDPOINT_ARN: endpointArn,
    AWS_PROFILE: "miru-team",
  });
});

for (const failure of ["invalid", "throws"] as const) {
  test(`keeps the current backend when endpoint validation ${failure}`, async () => {
    const before = await readStoredCredentials();
    const { response, invalidations } = await configure(async () => {
      if (failure === "throws") throw new Error("connection failed");
      return { valid: false, message: "Access denied" };
    });
    expect(response.result?.isError).toBe(true);
    expect(await readStoredCredentials()).toEqual(before);
    expect(process.env.TAKARA_API_KEY).toBe(fake("existing-api-key"));
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBeUndefined();
    expect(invalidations).toBe(0);
  });
}

test("rejects malformed ARNs before contacting AWS", async () => {
  const { response, invalidations } = await configure(
    async () => {
      throw new Error("should not contact AWS");
    },
    { endpoint_arn: "not-an-arn", aws_profile: "miru-team" },
  );
  expect(response.result?.isError).toBe(true);
  expect(response.result?.content[0]?.text).toContain("Invalid SageMaker endpoint ARN");
  expect(invalidations).toBe(0);
});

test("requires an existing profile name", async () => {
  const { response } = await configure(
    async () => {
      throw new Error("should not contact AWS");
    },
    { endpoint_arn: endpointArn, aws_profile: "  " },
  );
  expect(response.error?.code).toBe(-32602);
});

test("reports a host setting that would override the saved endpoint", async () => {
  process.env.MIRU_PLUGIN_SAGEMAKER_ENDPOINT_ARN = endpointArn;
  const { response, invalidations } = await configure(async () => {
    throw new Error("should not contact AWS");
  });
  expect(response.result?.isError).toBe(true);
  expect(response.result?.content[0]?.text).toContain("controlled by this host's plugin settings");
  expect((await readStoredCredentials())?.kind).toBe("api_key");
  expect(invalidations).toBe(0);
});
