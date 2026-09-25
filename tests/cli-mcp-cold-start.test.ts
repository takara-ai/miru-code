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
test(
  "cold start with zero stored credentials stays alive and serves tools/list",
  async () => {
    const credDir = await mkdtemp(join(tmpdir(), "miru-cli-cold-start-"));
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

    // Drain stderr concurrently so a crash on cold start is visible in the
    // failure message instead of silently discarded (it was piped but never
    // read before, so a startup exception on the child left no trace at all).
    let stderrText = "";
    const stderrDrain = (async () => {
      const stderrReader = proc.stderr.getReader();
      const stderrDecoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (value) {
            stderrText += stderrDecoder.decode(value, { stream: true });
          }
          if (done) {
            return;
          }
        }
      } finally {
        stderrReader.releaseLock();
      }
    })();

    const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];
    let readError: Error | null = null;

    try {
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
      // Keep stdin open until we have both replies. Ending the pipe early signals EOF
      // to StdioTransport, which closes the server mid-flight — flaky on Windows CI.

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        // Race the read loop against a hard deadline so a genuinely stuck child
        // fails the test instead of hanging the whole CI job. This alone isn't
        // enough, though: see the `done` check below.
        await Promise.race([
          (async () => {
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
              if (done) {
                // A closed stream's read() always resolves immediately, so
                // looping on it instead of stopping here spins the microtask
                // queue hard enough to starve setTimeout callbacks forever —
                // that's what actually hung windows-latest CI runs for over
                // an hour (see runs 36142996260, 36153369282, 36156588576),
                // not a blocking call: the Promise.race deadline below never
                // got a turn to fire either. Bail out the moment the stream
                // closes, whether or not both responses arrived.
                break;
              }
            }
          })(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("timed out waiting for tools/list response")),
              15_000,
            );
          }),
        ]);
      } finally {
        reader.releaseLock();
      }

      await writer.end();
    } catch (error) {
      readError = error instanceof Error ? error : new Error(String(error));
    } finally {
      // Always kill the child, even on timeout/failure — an orphaned subprocess
      // with an open stdout pipe is what pinned the CI job before (see above).
      proc.kill();
      const exitCode = await proc.exited;
      await stderrDrain;
      // 143 = SIGTERM from our own proc.kill(), not a crash exit code.
      expect([0, 143, null]).toContain(exitCode);
      await rm(credDir, { recursive: true, force: true });
    }

    if (readError || responses.length !== 2) {
      throw new Error(
        `expected 2 JSON-RPC responses on stdout, got ${responses.length}` +
          `${readError ? ` (${readError.message})` : ""}.\n` +
          `child stderr:\n${stderrText || "(empty)"}`,
      );
    }

    const toolsListResponse = responses.find((r) => r.id === 2);
    const toolNames = toolsListResponse?.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("auth");
    expect(toolNames).toContain("search");
  },
  { timeout: 20_000 },
);
