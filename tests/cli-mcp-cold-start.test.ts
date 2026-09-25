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
// TEMPORARY diagnostic instrumentation: pinpointing a Windows-only hang in this
// test (github.com/takara-ai/miru-code/actions/runs/36142996260 and
// 36153369282, both silent for the whole job timeout with no test output at
// all — meaning the JS thread itself is frozen, not just awaiting an
// unresolved promise, since bun's own per-test timeout never fired either).
// These marks go to the outer `bun test` process' own stderr (captured
// directly by the Actions runner, independent of the child's pipes under
// test) so we can see exactly which line never returns. Remove once the
// Windows hang is root-caused and fixed.
const mark = (label: string) => {
  process.stderr.write(`[cold-start-diag] ${label} @ ${Date.now()}\n`);
};

test(
  "cold start with zero stored credentials stays alive and serves tools/list",
  async () => {
    mark("test start");
    const credDir = await mkdtemp(join(tmpdir(), "miru-cli-cold-start-"));
    mark("mkdtemp done");
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
    mark("spawn returned");

    try {
      const writer = proc.stdin;
      const send = (message: unknown) => writer.write(`${JSON.stringify(message)}\n`);

      mark("before send #1 (initialize)");
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
      mark("after send #1 (initialize)");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      mark("after send #2 (notifications/initialized)");
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      mark("after send #3 (tools/list)");
      // Keep stdin open until we have both replies. Ending the pipe early signals EOF
      // to StdioTransport, which closes the server mid-flight — flaky on Windows CI.

      mark("before writer.flush()");
      await writer.flush();
      mark("after writer.flush()");

      mark("before getReader()");
      const reader = proc.stdout.getReader();
      mark("after getReader()");
      const decoder = new TextDecoder();
      let buffer = "";
      const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];

      try {
        // A locked, idle reader on the child's stdout pipe can pin the process
        // forever on Windows if the child never writes/closes again (observed:
        // github.com/takara-ai/miru-code/actions/runs/36142996260 hung 1h25m on
        // windows-latest with no output past this point). Race the read loop
        // against a hard deadline so a stuck child fails the test instead of
        // hanging the whole CI job.
        mark("before Promise.race");
        await Promise.race([
          (async () => {
            let iteration = 0;
            while (responses.length < 2) {
              iteration += 1;
              mark(`before reader.read() #${iteration}`);
              const { done, value } = await reader.read();
              mark(`after reader.read() #${iteration} done=${done} bytes=${value?.length ?? 0}`);
              if (value) {
                buffer += decoder.decode(value, { stream: true });
                let newline = buffer.indexOf("\n");
                while (newline !== -1) {
                  const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
                  buffer = buffer.slice(newline + 1);
                  if (line) {
                    responses.push(JSON.parse(line));
                    mark(`parsed response, responses.length=${responses.length}`);
                  }
                  newline = buffer.indexOf("\n");
                }
              }
              if (done && proc.exitCode !== null) {
                break;
              }
            }
          })(),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              mark("timeout fired");
              reject(new Error("timed out waiting for tools/list response"));
            }, 15_000);
          }),
        ]);
        mark("after Promise.race");
      } finally {
        reader.releaseLock();
      }

      mark("before writer.end()");
      await writer.end();
      mark("after writer.end()");

      // The process must not have exited on its own before we killed it — a crash
      // on cold start is exactly the regression this test guards against.
      expect(responses.length).toBe(2);

      const toolsListResponse = responses.find((r) => r.id === 2);
      const toolNames = toolsListResponse?.result?.tools?.map((t) => t.name) ?? [];
      expect(toolNames).toContain("auth");
      expect(toolNames).toContain("search");
    } finally {
      // Always kill the child, even on timeout/failure — an orphaned subprocess
      // with an open stdout pipe is exactly what pinned the CI job (see above).
      proc.kill();
      const exitCode = await proc.exited;
      // 143 = SIGTERM from our own proc.kill(), not a crash exit code.
      expect([0, 143, null]).toContain(exitCode);
      await rm(credDir, { recursive: true, force: true });
    }
  },
  { timeout: 20_000 },
);
