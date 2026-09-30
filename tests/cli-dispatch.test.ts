import { expect, test } from "bun:test";
import { join } from "node:path";
import { shouldRunMcp } from "../src/cli-mode.ts";

async function invoke(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "src/cli.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MIRU_NO_UPDATE_CHECK: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 5_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("bare miru in a terminal routes to help", async () => {
  expect(shouldRunMcp([], true, true)).toBe(false);
  expect(shouldRunMcp([], true, false)).toBe(false);
  expect(shouldRunMcp([], false, true)).toBe(false);
  const help = await invoke(["-h"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Show help in a terminal");
});

test("bare miru with headless stdio keeps the legacy MCP entrypoint", () => {
  expect(shouldRunMcp([], false, false)).toBe(true);
  expect(shouldRunMcp(["--benchmark"], false, false)).toBe(true);
  expect(shouldRunMcp(["--benchmark=false"], false, false)).toBe(true);
  expect(shouldRunMcp(["--ref", "main"], false, false)).toBe(true);
  expect(shouldRunMcp(["--content", "code"], false, false)).toBe(true);
  expect(shouldRunMcp(["mcp"], false, false)).toBe(true);
  expect(shouldRunMcp(["mcp", "--help"], false, false)).toBe(false);
  expect(shouldRunMcp(["--unknown"], false, false)).toBe(false);
});

test("miru mcp -h describes the explicit server command", async () => {
  const result = await invoke(["mcp", "-h"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("miru mcp [--ref BRANCH]");
});

test("unknown commands fail instead of starting the MCP server", async () => {
  const result = await invoke(["missing-command"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unknown command: missing-command");
});
