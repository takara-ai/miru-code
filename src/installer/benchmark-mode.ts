import { AGENT_TARGETS, type AgentTarget, type InstallAction } from "./agents.ts";
import { removeTomlBlock, stripJsonComments } from "./config.ts";

export const MCP_BENCHMARK_FLAG = "--benchmark";

const CODEX_MCP_HEADER = "[mcp_servers.miru]";

function codexMcpBlock(enabled: boolean): string {
  const args = enabled
    ? `["@takara-ai/miru-code", "${MCP_BENCHMARK_FLAG}"]`
    : '["@takara-ai/miru-code"]';
  return `${CODEX_MCP_HEADER}\ncommand = "bunx"\nargs = ${args}\n`;
}

export function withBenchmarkFlag(list: string[], enabled: boolean): string[] {
  const without = list.filter((item) => item !== MCP_BENCHMARK_FLAG);
  return enabled ? [...without, MCP_BENCHMARK_FLAG] : without;
}

export function listHasBenchmarkFlag(list: unknown): boolean {
  return Array.isArray(list) && list.some((item) => item === MCP_BENCHMARK_FLAG);
}

/** Toggle `--benchmark` on a JSON MCP server entry (`args` and/or array `command`). */
export function applyBenchmarkFlagToMcpEntry(
  entry: Record<string, unknown>,
  enabled: boolean,
): { entry: Record<string, unknown>; changed: boolean; enabled: boolean } {
  const next: Record<string, unknown> = { ...entry };
  let changed = false;

  if (Array.isArray(next.args)) {
    const args = next.args.filter((item): item is string => typeof item === "string");
    const updated = withBenchmarkFlag(args, enabled);
    if (JSON.stringify(updated) !== JSON.stringify(args)) {
      next.args = updated;
      changed = true;
    }
  }

  if (Array.isArray(next.command)) {
    const command = next.command.filter((item): item is string => typeof item === "string");
    const updated = withBenchmarkFlag(command, enabled);
    if (JSON.stringify(updated) !== JSON.stringify(command)) {
      next.command = updated;
      changed = true;
    }
  }

  return {
    entry: next,
    changed,
    enabled: mcpEntryHasBenchmark(next),
  };
}

export function mcpEntryHasBenchmark(entry: Record<string, unknown>): boolean {
  return listHasBenchmarkFlag(entry.args) || listHasBenchmarkFlag(entry.command);
}

export interface BenchmarkModeTargetResult {
  agent: string;
  path: string;
  action: InstallAction | "enabled" | "disabled" | "missing";
  enabled: boolean;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  try {
    const text = stripJsonComments(await Bun.file(path).text());
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeJsonObject(path: string, value: Record<string, unknown>): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function statusForToml(path: string): Promise<boolean | null> {
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  const text = await Bun.file(path).text();
  if (!text.includes(CODEX_MCP_HEADER)) {
    return null;
  }
  return text.includes(`"${MCP_BENCHMARK_FLAG}"`) || text.includes(`'${MCP_BENCHMARK_FLAG}'`);
}

async function setTomlBenchmark(
  path: string,
  enabled: boolean,
): Promise<InstallAction | "missing"> {
  if (!(await Bun.file(path).exists())) {
    return "missing";
  }
  const text = await Bun.file(path).text();
  if (!text.includes(CODEX_MCP_HEADER)) {
    return "missing";
  }
  const current = await statusForToml(path);
  if (current === enabled) {
    return "unchanged";
  }

  // Replace the miru block with the desired args, preserving the rest of the file.
  await removeTomlBlock(path);
  const existed = await Bun.file(path).exists();
  const existing = existed ? await Bun.file(path).text() : "";
  const base = existing.replace(/\n+$/, "");
  const block = codexMcpBlock(enabled);
  const next = base.length > 0 ? `${base}\n\n${block}` : block;
  await Bun.write(path, next.endsWith("\n") ? next : `${next}\n`);
  return "updated";
}

async function statusForJson(agent: AgentTarget): Promise<boolean | null> {
  const mcp = agent.mcp;
  if (mcp?.format !== "json") {
    return null;
  }
  const parsed = await readJsonObject(mcp.path);
  if (!parsed) {
    return null;
  }
  const section = parsed[mcp.key];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return null;
  }
  const entry = (section as Record<string, unknown>)[mcp.memberKey];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return mcpEntryHasBenchmark(entry as Record<string, unknown>);
}

async function setJsonBenchmark(
  agent: AgentTarget,
  enabled: boolean,
): Promise<InstallAction | "missing"> {
  const mcp = agent.mcp;
  if (mcp?.format !== "json") {
    return "missing";
  }
  const parsed = await readJsonObject(mcp.path);
  if (!parsed) {
    return "missing";
  }
  const sectionRaw = parsed[mcp.key];
  if (!sectionRaw || typeof sectionRaw !== "object" || Array.isArray(sectionRaw)) {
    return "missing";
  }
  const section = sectionRaw as Record<string, unknown>;
  const entryRaw = section[mcp.memberKey];
  if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
    return "missing";
  }

  const applied = applyBenchmarkFlagToMcpEntry(entryRaw as Record<string, unknown>, enabled);
  if (!applied.changed) {
    return "unchanged";
  }
  section[mcp.memberKey] = applied.entry;
  parsed[mcp.key] = section;
  await writeJsonObject(mcp.path, parsed);
  return "updated";
}

/** Inspect installed Miru MCP configs for `--benchmark`. */
export async function getBenchmarkModeStatus(): Promise<BenchmarkModeTargetResult[]> {
  const results: BenchmarkModeTargetResult[] = [];
  for (const agent of AGENT_TARGETS) {
    const mcp = agent.mcp;
    if (!mcp) {
      continue;
    }
    if (mcp.format === "toml") {
      const enabled = await statusForToml(mcp.path);
      results.push({
        agent: agent.displayName,
        path: mcp.path,
        action: enabled == null ? "missing" : enabled ? "enabled" : "disabled",
        enabled: enabled === true,
      });
      continue;
    }
    const enabled = await statusForJson(agent);
    results.push({
      agent: agent.displayName,
      path: mcp.path,
      action: enabled == null ? "missing" : enabled ? "enabled" : "disabled",
      enabled: enabled === true,
    });
  }
  return results;
}

/** Enable or disable `--benchmark` on every installed Miru MCP entry. */
export async function setBenchmarkMode(enabled: boolean): Promise<BenchmarkModeTargetResult[]> {
  const results: BenchmarkModeTargetResult[] = [];
  for (const agent of AGENT_TARGETS) {
    const mcp = agent.mcp;
    if (!mcp) {
      continue;
    }
    if (mcp.format === "toml") {
      const action = await setTomlBenchmark(mcp.path, enabled);
      results.push({
        agent: agent.displayName,
        path: mcp.path,
        action,
        enabled: action === "missing" ? false : enabled,
      });
      continue;
    }
    const action = await setJsonBenchmark(agent, enabled);
    results.push({
      agent: agent.displayName,
      path: mcp.path,
      action,
      enabled: action === "missing" ? false : enabled,
    });
  }
  return results;
}
