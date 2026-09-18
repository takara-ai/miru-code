import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for the plugin's `.claude-plugin/mcp.json` userConfig wiring,
// which always emits the flag with a literal value (`--benchmark=${user_config.benchmark}`)
// rather than omitting it — `runMcp` in src/cli.ts must parse both the bare
// `--benchmark` flag (used by the installer's rewritten configs) and the
// `--benchmark=true`/`--benchmark=false` value form (used by the plugin).
async function listToolNames(extraArg: string | null): Promise<string[]> {
  const credDir = await mkdtemp(join(tmpdir(), "miru-cli-benchmark-flag-"));
  try {
    const proc = Bun.spawn({
      cmd: extraArg ? ["bun", "src/cli.ts", extraArg] : ["bun", "src/cli.ts"],
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
        clientInfo: { name: "benchmark-flag-test", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];

    while (responses.length < 2) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
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
    await writer.end();
    proc.kill();
    await proc.exited;

    const toolsListResponse = responses.find((r) => r.id === 2);
    return toolsListResponse?.result?.tools?.map((t) => t.name) ?? [];
  } finally {
    await rm(credDir, { recursive: true, force: true });
  }
}

test("--benchmark=true registers read_benchmark", async () => {
  const toolNames = await listToolNames("--benchmark=true");
  expect(toolNames).toContain("read_benchmark");
});

test("--benchmark=false does not register read_benchmark", async () => {
  const toolNames = await listToolNames("--benchmark=false");
  expect(toolNames).not.toContain("read_benchmark");
});

test("bare --benchmark (installer form) still registers read_benchmark", async () => {
  const toolNames = await listToolNames("--benchmark");
  expect(toolNames).toContain("read_benchmark");
});
