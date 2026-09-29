import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTarget } from "../src/installer/agents.ts";
import {
  applyBenchmarkFlagToMcpEntry,
  getBenchmarkModeStatus,
  listHasBenchmarkFlag,
  MCP_BENCHMARK_FLAG,
  setBenchmarkMode,
  withBenchmarkFlag,
  withPreservedBenchmarkFlag,
} from "../src/installer/benchmark-mode.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function target(id: AgentTarget["id"], path: string, format: "json" | "toml"): AgentTarget {
  return {
    id,
    displayName: String(id),
    binary: null,
    configDir: null,
    mcp: { path, key: "mcpServers", memberKey: "miru", entry: {}, format },
    instructionsPath: null,
    cursorRulesPath: null,
    hooksPath: null,
    hooksFormat: null,
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: null,
    steSkillDir: null,
  };
}

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

  test("reads and toggles JSON and TOML MCP entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "miru-bench-mode-state-"));
    const jsonPath = join(dir, "mcp.json");
    const tomlPath = join(dir, "config.toml");
    const jsonTarget = target("claude", jsonPath, "json");
    const tomlTarget = target("codex", tomlPath, "toml");
    const absentTarget = target("cursor", join(dir, "absent.json"), "json");
    const noMcpTarget = { ...jsonTarget, id: "gemini", mcp: null } as AgentTarget;

    expect(
      (await getBenchmarkModeStatus([jsonTarget, tomlTarget, absentTarget, noMcpTarget])).map(
        (result) => result.action,
      ),
    ).toEqual(["missing", "missing", "missing"]);
    expect(
      (await setBenchmarkMode(true, [jsonTarget, tomlTarget])).map((result) => result.action),
    ).toEqual(["missing", "missing"]);

    await Bun.write(jsonPath, '{ // comment\n "mcpServers": {"miru": {"args": ["bunx"]}}}\n');
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.action).toBe("disabled");
    expect((await setBenchmarkMode(true, [jsonTarget]))[0]?.action).toBe("updated");
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.enabled).toBe(true);
    expect((await setBenchmarkMode(true, [jsonTarget]))[0]?.action).toBe("unchanged");
    expect((await setBenchmarkMode(false, [jsonTarget]))[0]?.action).toBe("updated");
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.enabled).toBe(false);

    await Bun.write(jsonPath, "not json");
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(false, [jsonTarget]))[0]?.action).toBe("missing");

    await Bun.write(tomlPath, "[other]\nvalue = true\n");
    expect((await getBenchmarkModeStatus([tomlTarget]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(true, [tomlTarget]))[0]?.action).toBe("missing");
    await Bun.write(
      tomlPath,
      '[other]\nvalue = true\n\n[mcp_servers.miru]\ncommand = "bunx"\nargs = ["@takara-ai/miru-code"]\n',
    );
    expect((await getBenchmarkModeStatus([tomlTarget]))[0]?.action).toBe("disabled");
    expect((await setBenchmarkMode(true, [tomlTarget]))[0]?.action).toBe("updated");
    expect((await getBenchmarkModeStatus([tomlTarget]))[0]?.enabled).toBe(true);
    expect((await setBenchmarkMode(true, [tomlTarget]))[0]?.action).toBe("unchanged");
    expect((await setBenchmarkMode(false, [tomlTarget]))[0]?.action).toBe("updated");
    expect(await Bun.file(tomlPath).text()).toContain("[other]");
  });

  test("treats invalid JSON structure and nonstandard formats as missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "miru-bench-mode-invalid-"));
    const path = join(dir, "mcp.json");
    const jsonTarget = target("claude", path, "json");
    const unknownFormat = {
      ...jsonTarget,
      id: "cursor",
      mcp: { ...jsonTarget.mcp!, format: "unsupported" as never },
    } as AgentTarget;

    await Bun.write(path, "[]");
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(true, [jsonTarget]))[0]?.action).toBe("missing");

    await Bun.write(path, '{"mcpServers":[]}');
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(true, [jsonTarget]))[0]?.action).toBe("missing");

    await Bun.write(path, '{"mcpServers":{"miru":[]}}');
    expect((await getBenchmarkModeStatus([jsonTarget]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(true, [jsonTarget]))[0]?.action).toBe("missing");
    expect((await getBenchmarkModeStatus([unknownFormat]))[0]?.action).toBe("missing");
    expect((await setBenchmarkMode(true, [unknownFormat]))[0]?.action).toBe("missing");
  });
});
