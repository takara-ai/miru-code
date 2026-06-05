import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentTemplate } from "../src/agents.ts";
import { type AgentTarget, MIRU_END, MIRU_START } from "../src/installer/agents.ts";
import {
  mergeJsonMember,
  mergeTomlBlock,
  removeJsonMember,
  removeMarked,
  removeTomlBlock,
  replaceOrAppendMarked,
} from "../src/installer/config.ts";
import { applyMcp, applySubagent } from "../src/installer/installer.ts";

const BLOCK = `${MIRU_START}\n## Miru\ninstructions\n${MIRU_END}\n`;
const BLOCK_V2 = `${MIRU_START}\n## Miru\nupdated\n${MIRU_END}\n`;

function claudeTarget(root: string): AgentTarget {
  return {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    configDir: join(root, ".claude"),
    mcp: {
      path: join(root, ".claude.json"),
      key: "mcpServers",
      memberKey: "miru",
      entry: {
        command: "bunx",
        args: ["@takara-ai/miru-code"],
        type: "stdio",
        env: { TAKARA_API_KEY: "$" + "{TAKARA_API_KEY}" },
      },
      format: "json",
    },
    instructionsPath: join(root, ".claude", "CLAUDE.md"),
    subagentPath: join(root, ".claude", "agents", "miru-code.md"),
    subagentId: "claude",
  };
}

describe("installer config", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "miru-installer-"));
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mergeJsonMember creates fresh MCP config", async () => {
    const path = join(root, "mcp.json");
    expect(await mergeJsonMember(path, "mcpServers", "miru", { command: "bunx" })).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as Record<string, Record<string, unknown>>;
    expect(data.mcpServers?.miru).toEqual({ command: "bunx" });
  });

  test("mergeJsonMember preserves other MCP entries", async () => {
    const path = join(root, "mcp.json");
    await Bun.write(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));
    expect(await mergeJsonMember(path, "mcpServers", "miru", { command: "bunx" })).toBe("updated");
    const data = JSON.parse(await Bun.file(path).text()) as Record<string, Record<string, unknown>>;
    expect(data.mcpServers?.other).toEqual({ command: "x" });
    expect(data.mcpServers?.miru).toEqual({ command: "bunx" });
  });

  test("mergeJsonMember is idempotent", async () => {
    const path = join(root, "mcp.json");
    const value = { command: "bunx", args: ["@takara-ai/miru-code"] };
    expect(await mergeJsonMember(path, "mcpServers", "miru", value)).toBe("created");
    expect(await mergeJsonMember(path, "mcpServers", "miru", value)).toBe("unchanged");
  });

  test("removeJsonMember removes miru only", async () => {
    const path = join(root, "mcp.json");
    await Bun.write(
      path,
      JSON.stringify(
        { mcpServers: { miru: { command: "bunx" }, other: { command: "x" } } },
        null,
        2,
      ),
    );
    expect(await removeJsonMember(path, "mcpServers", "miru")).toBe("removed");
    const data = JSON.parse(await Bun.file(path).text()) as Record<string, Record<string, unknown>>;
    expect(data.mcpServers?.miru).toBeUndefined();
    expect(data.mcpServers?.other).toEqual({ command: "x" });
  });

  test("replaceOrAppendMarked creates and replaces blocks", async () => {
    const path = join(root, "CLAUDE.md");
    expect(await replaceOrAppendMarked(path, BLOCK)).toBe("created");
    expect((await Bun.file(path).text()).includes(MIRU_START)).toBe(true);

    expect(await replaceOrAppendMarked(path, BLOCK_V2)).toBe("updated");
    expect((await Bun.file(path).text()).includes("updated")).toBe(true);
    expect((await Bun.file(path).text()).includes("instructions")).toBe(false);
  });

  test("removeMarked strips block and deletes empty file", async () => {
    const path = join(root, "CLAUDE.md");
    await Bun.write(path, `# Before\n\n${BLOCK}\n# After\n`);
    expect(await removeMarked(path)).toBe("removed");
    const text = await Bun.file(path).text();
    expect(text.includes(MIRU_START)).toBe(false);
    expect(text.includes("# Before")).toBe(true);
    expect(text.includes("# After")).toBe(true);

    await Bun.write(path, BLOCK);
    expect(await removeMarked(path)).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("codex toml merge and remove", async () => {
    const path = join(root, "config.toml");
    await Bun.write(path, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(await mergeTomlBlock(path)).toBe("updated");
    const merged = await Bun.file(path).text();
    expect(merged.includes("[mcp_servers.miru]")).toBe(true);
    expect(merged.includes("[mcp_servers.other]")).toBe(true);
    expect(await mergeTomlBlock(path)).toBe("unchanged");

    expect(await removeTomlBlock(path)).toBe("removed");
    const remaining = await Bun.file(path).text();
    expect(remaining.includes("[mcp_servers.miru]")).toBe(false);
    expect(remaining.includes("[mcp_servers.other]")).toBe(true);
  });
});

describe("installer apply", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "miru-installer-"));
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applyMcp installs miru MCP entry", async () => {
    const agent = claudeTarget(root);
    const result = await applyMcp(agent, "install");
    expect(result?.action).toBe("created");
    const mcpPath = agent.mcp?.path ?? "";
    const data = JSON.parse(await Bun.file(mcpPath).text()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(data.mcpServers?.miru).toBeDefined();
  });

  test("applySubagent writes template", async () => {
    const agent = claudeTarget(root);
    const result = await applySubagent(agent, "install");
    expect(result?.action).toBe("created");
    const subagentPath = agent.subagentPath ?? "";
    const text = await Bun.file(subagentPath).text();
    const template = await loadAgentTemplate("claude");
    expect(text).toBe(template);

    expect((await applySubagent(agent, "uninstall"))?.action).toBe("removed");
    expect(await Bun.file(subagentPath).exists()).toBe(false);
  });
});
