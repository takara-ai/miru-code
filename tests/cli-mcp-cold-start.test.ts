import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for the actual bug PRD-311's headless-auth-tool fix addresses:
// the plugin's .mcp.json spawns `bunx @takara-ai/miru-code` with no subcommand,
// which used to route through a credential pre-flight that threw and killed the
// whole process on a cold start with no cached credentials — before any MCP tool
// ever registered. This spawns the real CLI entrypoint the same way (no args) and
// asserts the process stays alive and answers tools/list, rather than testing the
// pieces `runMcpWithCredentials` calls in isolation.
test("cold start with zero stored credentials stays alive and serves tools/list", async () => {
  const credDir = await mkdtemp(join(tmpdir(), "miru-cli-cold-start-"));
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "src/cli.ts"],
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        MIRU_CREDENTIALS_DIR: credDir,
        TAKARA_API_KEY: "",
        MIRU_SAGEMAKER_ENDPOINT_ARN: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const writer = proc.stdin;
    const send = (message: unknown) => writer.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "cold-start-test", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await writer.end();

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];

    const deadline = Date.now() + 10_000;
    while (responses.length < 2 && Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ]);
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            responses.push(JSON.parse(line));
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (done && proc.exitCode !== null) {
        break;
      }
    }

    reader.releaseLock();
    proc.kill();
    const exitCode = await proc.exited;

    // The process must not have exited on its own before we killed it — a crash
    // on cold start is exactly the regression this test guards against.
    expect(responses.length).toBe(2);

    const toolsListResponse = responses.find((r) => r.id === 2);
    const toolNames = toolsListResponse?.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("auth");
    expect(toolNames).toContain("search");

    // 143 = SIGTERM from our own proc.kill(), not a crash exit code.
    expect([0, 143, null]).toContain(exitCode);
  } finally {
    await rm(credDir, { recursive: true, force: true });
  }
}, 15_000);
