import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBenchmarkFlagToMcpEntry,
  listHasBenchmarkFlag,
  MCP_BENCHMARK_FLAG,
  withBenchmarkFlag,
  withPreservedBenchmarkFlag,
} from "../src/installer/benchmark-mode.ts";

describe("benchmark mode helpers", () => {
  test("withBenchmarkFlag adds and removes the flag idempotently", () => {
    expect(withBenchmarkFlag(["@takara-ai/miru-code"], true)).toEqual([
      "@takara-ai/miru-code",
      MCP_BENCHMARK_FLAG,
    ]);
    expect(withBenchmarkFlag(["@takara-ai/miru-code", MCP_BENCHMARK_FLAG], true)).toEqual([
      "@takara-ai/miru-code",
      MCP_BENCHMARK_FLAG,
    ]);
    expect(withBenchmarkFlag(["@takara-ai/miru-code", MCP_BENCHMARK_FLAG], false)).toEqual([
      "@takara-ai/miru-code",
    ]);
    expect(listHasBenchmarkFlag(["@takara-ai/miru-code", MCP_BENCHMARK_FLAG])).toBe(true);
  });

  test("applyBenchmarkFlagToMcpEntry updates args-style entries", () => {
    const on = applyBenchmarkFlagToMcpEntry(
      { command: "bunx", args: ["@takara-ai/miru-code"], type: "stdio" },
      true,
    );
    expect(on.changed).toBe(true);
    expect(on.enabled).toBe(true);
    expect(on.entry.args).toEqual(["@takara-ai/miru-code", MCP_BENCHMARK_FLAG]);

    const off = applyBenchmarkFlagToMcpEntry(on.entry, false);
    expect(off.changed).toBe(true);
    expect(off.enabled).toBe(false);
    expect(off.entry.args).toEqual(["@takara-ai/miru-code"]);

    const again = applyBenchmarkFlagToMcpEntry(off.entry, false);
    expect(again.changed).toBe(false);
  });

  test("applyBenchmarkFlagToMcpEntry updates OpenCode command-array entries", () => {
    const on = applyBenchmarkFlagToMcpEntry(
      { command: ["bunx", "@takara-ai/miru-code"], type: "local", enabled: true },
      true,
    );
    expect(on.entry.command).toEqual(["bunx", "@takara-ai/miru-code", MCP_BENCHMARK_FLAG]);
    const off = applyBenchmarkFlagToMcpEntry(on.entry, false);
    expect(off.entry.command).toEqual(["bunx", "@takara-ai/miru-code"]);
  });

  test("applyBenchmarkFlagToMcpEntry can clear a persisted Cursor-style mcp.json payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-mode-"));
    const path = join(dir, "mcp.json");
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          mcpServers: {
            miru: {
              command: "bunx",
              args: ["@takara-ai/miru-code", "--benchmark"],
              type: "stdio",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const parsed = JSON.parse(await Bun.file(path).text()) as {
      mcpServers: { miru: Record<string, unknown> };
    };
    const updated = applyBenchmarkFlagToMcpEntry(parsed.mcpServers.miru, false);
    expect(updated.enabled).toBe(false);
    parsed.mcpServers.miru = updated.entry;
    await Bun.write(path, `${JSON.stringify(parsed, null, 2)}\n`);
    const after = JSON.parse(await Bun.file(path).text()) as typeof parsed;
    expect(after.mcpServers.miru.args).toEqual(["@takara-ai/miru-code"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("withPreservedBenchmarkFlag keeps flag on canonical install entry", () => {
    const canonical = { command: "bunx", args: ["@takara-ai/miru-code"], type: "stdio" };
    const existing = {
      command: "bunx",
      args: ["@takara-ai/miru-code", MCP_BENCHMARK_FLAG],
      type: "stdio",
    };
    expect(withPreservedBenchmarkFlag(canonical, existing).args).toEqual([
      "@takara-ai/miru-code",
      MCP_BENCHMARK_FLAG,
    ]);
    expect(withPreservedBenchmarkFlag(canonical, null)).toEqual(canonical);
  });
});
