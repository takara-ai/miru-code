import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAgentTemplate } from "../src/agents.ts";
import {
  appendBenchmarkQuery,
  recordFromBenchmark,
  runWithBenchmarkHistoryPath,
} from "../src/benchmark/history.ts";
import type { SearchBenchmarkBlock } from "../src/benchmark/types.ts";
import { printCommandHelp } from "../src/help.ts";
import {
  AGENT_TARGETS,
  type AgentTarget,
  agentsCavemanSkillPath,
  agentsSteSkillDir,
  isCopilotInstalled,
  MIRU_END,
  MIRU_START,
  nativeCavemanSkillPath,
  nativeSteSkillDir,
  opencodeConfigDir,
  visualStudioMcpPath,
} from "../src/installer/agents.ts";
import {
  codexSkillsFeatureEnabled,
  ensureCodexSkillsFeature,
  mergeJsonMember,
  mergeTomlBlock,
  removeJsonMember,
  removeMarked,
  removeTomlBlock,
  replaceOrAppendMarked,
} from "../src/installer/config.ts";
import {
  applyCaveman,
  applyHooks,
  applyMcp,
  applySte,
  applySubagent,
  codexCavemanPlanNote,
  INTEGRATIONS,
  integrationsForAgents,
  removeUninstallLocalData,
} from "../src/installer/installer.ts";
import { CAVEMAN_SKILL_MD } from "../src/installer/style-packs/caveman.ts";
import { STE_REFERENCE_FILES, STE_SKILL_MD } from "../src/installer/style-packs/ste/skill.ts";

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
      },
      format: "json",
    },
    instructionsPath: join(root, ".claude", "CLAUDE.md"),
    cursorRulesPath: null,
    hooksPath: join(root, ".claude", "settings.json"),
    hooksFormat: "claude",
    subagentPath: join(root, ".claude", "agents", "miru-code.md"),
    subagentId: "claude",
    cavemanSkillPath: join(root, ".claude", "skills", "caveman", "SKILL.md"),
    steSkillDir: join(root, ".claude", "skills", "ste"),
  };
}

function copilotFamilyTargets(root: string): {
  shared: string;
  ownersPath: string;
  family: AgentTarget[];
  copilot: AgentTarget;
  vscode: AgentTarget;
  visualstudio: AgentTarget;
} {
  const shared = join(root, ".agents", "skills", "caveman", "SKILL.md");
  const base: AgentTarget = {
    ...claudeTarget(root),
    cavemanSkillPath: shared,
    steSkillDir: null,
    mcp: null,
    instructionsPath: null,
    subagentPath: null,
    subagentId: null,
  };
  const copilot: AgentTarget = { ...base, id: "copilot", displayName: "GitHub Copilot" };
  const vscode: AgentTarget = { ...base, id: "vscode", displayName: "VS Code" };
  const visualstudio: AgentTarget = {
    ...base,
    id: "visualstudio",
    displayName: "Visual Studio",
  };
  return {
    shared,
    ownersPath: join(root, ".agents", "skills", "caveman", "miru-owners.json"),
    family: [copilot, vscode, visualstudio],
    copilot,
    vscode,
    visualstudio,
  };
}

/** Shared `~/.agents/skills/ste` family used by most installer IDEs (not Claude/Kiro). */
function sharedSteFamilyTargets(root: string): {
  skillDir: string;
  skillPath: string;
  ownersPath: string;
  family: AgentTarget[];
  cursor: AgentTarget;
  vscode: AgentTarget;
  codex: AgentTarget;
} {
  const skillDir = join(root, ".agents", "skills", "ste");
  const base: AgentTarget = {
    ...claudeTarget(root),
    cavemanSkillPath: null,
    steSkillDir: skillDir,
    mcp: null,
    instructionsPath: null,
    subagentPath: null,
    subagentId: null,
  };
  const cursor: AgentTarget = { ...base, id: "cursor", displayName: "Cursor" };
  const vscode: AgentTarget = { ...base, id: "vscode", displayName: "VS Code" };
  const codex: AgentTarget = {
    ...base,
    id: "codex",
    displayName: "Codex",
    mcp: {
      path: join(root, ".codex", "config.toml"),
      key: "mcp_servers",
      memberKey: "miru",
      entry: {},
      format: "toml",
    },
  };
  return {
    skillDir,
    skillPath: join(skillDir, "SKILL.md"),
    ownersPath: join(skillDir, "miru-owners.json"),
    family: [cursor, vscode, codex],
    cursor,
    vscode,
    codex,
  };
}

describe("installer config", () => {
  test("MCP agent entries do not embed TAKARA_API_KEY in env", () => {
    for (const agent of AGENT_TARGETS) {
      if (agent.mcp?.format !== "json") {
        continue;
      }
      const env = agent.mcp.entry.env as Record<string, unknown> | undefined;
      if (env) {
        expect(env.TAKARA_API_KEY).toBeUndefined();
      }
    }
  });

  test("Visual Studio is included in installer agents", () => {
    expect(AGENT_TARGETS.some((agent) => agent.id === "visualstudio")).toBe(true);
  });

  test("hook-capable agents include expected formats", () => {
    const byId = Object.fromEntries(AGENT_TARGETS.map((agent) => [agent.id, agent]));
    expect(byId.gemini?.hooksFormat).toBe("gemini");
    expect(byId.codex?.hooksFormat).toBe("claude");
    expect(byId.vscode?.hooksFormat).toBe("vscode");
    expect(byId.kiro?.hooksFormat).toBe("kiro");
    expect(byId.opencode?.hooksFormat).toBe("opencode");
    expect(byId.windsurf?.hooksFormat).toBe("windsurf");
  });

  test("search hooks are off by default in installer choices", () => {
    const hooksIntegration = INTEGRATIONS.find((entry) => entry.id === "hooks");
    expect(hooksIntegration?.defaultChecked).toBe(false);
    expect(hooksIntegration?.experimental).toBe(true);
  });

  test("T10: caveman integration is experimental and unchecked by default", () => {
    const caveman = INTEGRATIONS.find((entry) => entry.id === "caveman");
    expect(caveman?.experimental).toBe(true);
    expect(caveman?.defaultChecked).toBe(false);
    expect(caveman?.planPath).toBeDefined();
  });

  test("caveman skill paths: shared ~/.agents/skills except Claude and Kiro", () => {
    const home = homedir();
    const shared = agentsCavemanSkillPath(home);
    for (const agent of AGENT_TARGETS) {
      const expected =
        agent.id === "claude" || agent.id === "kiro"
          ? nativeCavemanSkillPath(home, agent.id)
          : shared;
      expect(agent.cavemanSkillPath).toBe(expected);
      expect(integrationsForAgents([agent]).some((entry) => entry.id === "caveman")).toBe(true);
    }
  });

  test("OpenCode config dir follows XDG_CONFIG_HOME; skills use ~/.agents/skills", () => {
    const home = "/home/user";
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/miru-xdg-test";
      expect(opencodeConfigDir(home)).toBe(join("/tmp/miru-xdg-test", "opencode"));
      expect(agentsCavemanSkillPath(home)).toBe(
        join(home, ".agents", "skills", "caveman", "SKILL.md"),
      );
      expect(agentsSteSkillDir(home)).toBe(join(home, ".agents", "skills", "ste"));

      delete process.env.XDG_CONFIG_HOME;
      expect(opencodeConfigDir(home)).toBe(join(home, ".config", "opencode"));
      expect(agentsCavemanSkillPath(home)).toBe(
        join(home, ".agents", "skills", "caveman", "SKILL.md"),
      );
      expect(agentsSteSkillDir(home)).toBe(join(home, ".agents", "skills", "ste"));
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prev;
      }
    }
  });

  test("T15: ste integration is experimental and unchecked by default", () => {
    const ste = INTEGRATIONS.find((entry) => entry.id === "ste");
    expect(ste?.experimental).toBe(true);
    expect(ste?.defaultChecked).toBe(false);
    expect(ste?.planPath).toBeDefined();
  });

  test("ste skill dirs: shared ~/.agents/skills except Claude and Kiro", () => {
    const home = homedir();
    const shared = agentsSteSkillDir(home);
    for (const agent of AGENT_TARGETS) {
      const expected =
        agent.id === "claude" || agent.id === "kiro" ? nativeSteSkillDir(home, agent.id) : shared;
      expect(agent.steSkillDir).toBe(expected);
      expect(integrationsForAgents([agent]).some((entry) => entry.id === "ste")).toBe(true);
    }
  });

  test("cursor rules is only offered when Cursor is selected", () => {
    for (const agent of AGENT_TARGETS) {
      expect(integrationsForAgents([agent]).some((entry) => entry.id === "rules")).toBe(
        agent.id === "cursor",
      );
    }
  });
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

  test("mergeJsonMember preserves JSONC comments and unrelated keys", async () => {
    const path = join(root, "opencode.jsonc");
    await Bun.write(
      path,
      `{
  // keep this comment
  "mcp": {
    "existing": { "enabled": true }
  }
}
`,
    );
    expect(
      await mergeJsonMember(path, "mcp", "miru", { command: ["bunx", "@takara-ai/miru-code"] }),
    ).toBe("updated");
    const updated = await Bun.file(path).text();
    expect(updated).toContain("// keep this comment");
    expect(updated).toContain('"existing"');
    expect(updated).toContain('"miru"');
  });

  test("mergeJsonMember adds root mcpServers without touching nested Claude projects", async () => {
    const path = join(root, ".claude.json");
    const entry = {
      command: "bunx",
      args: ["@takara-ai/miru-code"],
      type: "stdio",
    };
    // https:// in a string must not be treated as JSONC // comments.
    await Bun.write(
      path,
      JSON.stringify(
        {
          tip: "https://support.claude.com/en/articles/example",
          projects: {
            "/repo/a": {
              mcpServers: {
                miru: { command: "bunx", args: ["old"], type: "stdio" },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    expect(await mergeJsonMember(path, "mcpServers", "miru", entry)).toBe("updated");
    const data = JSON.parse(await Bun.file(path).text()) as {
      mcpServers?: { miru?: unknown };
      projects: { "/repo/a": { mcpServers: { miru: { args: string[] } } } };
    };
    expect(data.mcpServers?.miru).toEqual(entry);
    expect(data.projects["/repo/a"].mcpServers.miru.args).toEqual(["old"]);
  });

  test("mergeJsonMember JSONC root section ignores nested mcpServers", async () => {
    const path = join(root, "settings.jsonc");
    await Bun.write(
      path,
      `{
  // keep this comment
  "projects": {
    "/repo/a": {
      "mcpServers": {
        "miru": { "command": "nested" }
      }
    }
  }
}
`,
    );
    const entry = { command: "bunx", args: ["@takara-ai/miru-code"], type: "stdio" };
    expect(await mergeJsonMember(path, "mcpServers", "miru", entry)).toBe("updated");
    const data = JSON.parse((await Bun.file(path).text()).replace(/^\s*\/\/.*$/gm, "")) as {
      mcpServers?: { miru?: unknown };
      projects: { "/repo/a": { mcpServers: { miru: { command: string } } } };
    };
    expect(data.mcpServers?.miru).toEqual(entry);
    expect(data.projects["/repo/a"].mcpServers.miru.command).toBe("nested");
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

  test("removeJsonMember from JSONC keeps comments and unrelated members", async () => {
    const path = join(root, "opencode.jsonc");
    await Bun.write(
      path,
      `{
  // keep this comment
  "mcp": {
    "miru": { "command": ["bunx", "@takara-ai/miru-code"] },
    "existing": { "enabled": true }
  }
}
`,
    );
    expect(await removeJsonMember(path, "mcp", "miru")).toBe("removed");
    const updated = await Bun.file(path).text();
    expect(updated).toContain("// keep this comment");
    expect(updated).toContain('"existing"');
    expect(updated).not.toContain('"miru"');
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
    expect(merged.includes("TAKARA_API_KEY")).toBe(false);
    expect(await mergeTomlBlock(path)).toBe("unchanged");

    expect(await removeTomlBlock(path)).toBe("removed");
    const remaining = await Bun.file(path).text();
    expect(remaining.includes("[mcp_servers.miru]")).toBe(false);
    expect(remaining.includes("[mcp_servers.other]")).toBe(true);
  });

  test("codex toml merge preserves --benchmark across reinstall", async () => {
    const path = join(root, "config.toml");
    await Bun.write(
      path,
      `[mcp_servers.miru]
command = "bunx"
args = ["@takara-ai/miru-code", "--benchmark"]
`,
    );
    expect(await mergeTomlBlock(path)).toBe("unchanged");

    // Force a rewrite by tweaking whitespace-equivalent-but-not-identical block...
    // Actually unchanged when exact match. Simulate outdated package path drift:
    await Bun.write(
      path,
      `[mcp_servers.miru]
command = "bunx"
args = ["@takara-ai/miru-code@old", "--benchmark"]
`,
    );
    expect(await mergeTomlBlock(path)).toBe("updated");
    const text = await Bun.file(path).text();
    expect(text).toContain('"--benchmark"');
    expect(text).toContain("@takara-ai/miru-code");
    expect(text).not.toContain("@takara-ai/miru-code@old");
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

  test("visualStudioMcpPath uses user profile .mcp.json", () => {
    const prev = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = join(root, "win-profile");
      expect(visualStudioMcpPath()).toBe(join(root, "win-profile", ".mcp.json"));
    } finally {
      if (prev === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prev;
      }
    }
  });

  test("applyMcp installs miru into Visual Studio servers config", async () => {
    const agent: AgentTarget = {
      id: "visualstudio",
      displayName: "Visual Studio",
      binary: null,
      configDir: null,
      mcp: {
        path: join(root, ".mcp.json"),
        key: "servers",
        memberKey: "miru",
        entry: {
          command: "bunx",
          args: ["@takara-ai/miru-code"],
          type: "stdio",
        },
        format: "json",
      },
      instructionsPath: null,
      cursorRulesPath: null,
      hooksPath: null,
      hooksFormat: null,
      subagentPath: null,
      subagentId: null,
      cavemanSkillPath: null,
      steSkillDir: null,
    };
    const result = await applyMcp(agent, "install");
    expect(result?.action).toBe("created");
    const data = JSON.parse(await Bun.file(join(root, ".mcp.json")).text()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(data.servers?.miru).toBeDefined();
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
    const miru = data.mcpServers?.miru as Record<string, unknown> | undefined;
    expect(miru).toBeDefined();
    expect(miru?.command).toBe("bunx");
    expect(miru?.args).toEqual(["@takara-ai/miru-code"]);
    expect(miru?.env).toBeUndefined();
  });

  test("applyMcp installs Claude root mcpServers when only project MCP exists", async () => {
    const agent = claudeTarget(root);
    const mcpPath = agent.mcp?.path ?? "";
    await Bun.write(
      mcpPath,
      JSON.stringify(
        {
          tip: "https://support.claude.com/en/articles/example",
          projects: {
            "/Users/me/Code/ds1": {
              mcpServers: {
                miru: {
                  command: "bunx",
                  args: ["@takara-ai/miru-code"],
                  type: "stdio",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await applyMcp(agent, "install");
    expect(result?.action).toBe("updated");
    const data = JSON.parse(await Bun.file(mcpPath).text()) as {
      mcpServers?: { miru?: { command: string; args: string[]; type: string } };
      projects: {
        "/Users/me/Code/ds1": { mcpServers: { miru: { args: string[] } } };
      };
    };
    expect(data.mcpServers?.miru).toEqual({
      command: "bunx",
      args: ["@takara-ai/miru-code"],
      type: "stdio",
    });
    expect(data.projects["/Users/me/Code/ds1"].mcpServers.miru.args).toEqual([
      "@takara-ai/miru-code",
    ]);
  });

  test("applyMcp preserves --benchmark when reinstalling", async () => {
    const agent = claudeTarget(root);
    await applyMcp(agent, "install");
    const mcpPath = agent.mcp?.path ?? "";
    const data = JSON.parse(await Bun.file(mcpPath).text()) as {
      mcpServers: { miru: { command: string; args: string[]; type: string } };
    };
    data.mcpServers.miru.args = ["@takara-ai/miru-code", "--benchmark"];
    await Bun.write(mcpPath, `${JSON.stringify(data, null, 2)}\n`);

    const again = await applyMcp(agent, "install");
    expect(again?.action).toBe("unchanged");
    const after = JSON.parse(await Bun.file(mcpPath).text()) as typeof data;
    expect(after.mcpServers.miru.args).toEqual(["@takara-ai/miru-code", "--benchmark"]);
  });

  test("applyHooks installs Claude PreToolUse hook", async () => {
    const agent = claudeTarget(root);
    const result = await applyHooks(agent, "install");
    expect(result?.action).toBe("created");
    const settings = JSON.parse(await Bun.file(agent.hooksPath ?? "").text()) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
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

  test("T6: applyCaveman installs Cursor skill", async () => {
    const skillPath = join(root, ".agents", "skills", "caveman", "SKILL.md");
    const agent: AgentTarget = {
      ...claudeTarget(root),
      id: "cursor",
      displayName: "Cursor",
      cavemanSkillPath: skillPath,
      mcp: null,
      instructionsPath: null,
      subagentPath: null,
      subagentId: null,
    };
    const result = await applyCaveman(agent, "install");
    expect(result?.action).toBe("created");
    expect(result?.path).toBe(skillPath);
    expect(await Bun.file(skillPath).text()).toBe(CAVEMAN_SKILL_MD);
  });

  test("T7: applyCaveman re-install updates skill content", async () => {
    const agent = claudeTarget(root);
    expect((await applyCaveman(agent, "install"))?.action).toBe("created");
    const skillPath = agent.cavemanSkillPath ?? "";
    await Bun.write(skillPath, "stale\n");
    expect((await applyCaveman(agent, "install"))?.action).toBe("updated");
    expect(await Bun.file(skillPath).text()).toBe(CAVEMAN_SKILL_MD);
  });

  test("T7b: applyCaveman reports unchanged when content matches", async () => {
    const agent = claudeTarget(root);
    expect((await applyCaveman(agent, "install"))?.action).toBe("created");
    expect((await applyCaveman(agent, "install"))?.action).toBe("unchanged");
  });

  test("T8: applyCaveman uninstall removes skill and leaves MCP untouched", async () => {
    const agent = claudeTarget(root);
    await applyMcp(agent, "install");
    await applyCaveman(agent, "install");
    const skillPath = agent.cavemanSkillPath ?? "";
    const mcpPath = agent.mcp?.path ?? "";

    expect((await applyCaveman(agent, "uninstall"))?.action).toBe("removed");
    expect(await Bun.file(skillPath).exists()).toBe(false);
    expect(existsSync(dirname(skillPath))).toBe(false);
    expect(await Bun.file(mcpPath).exists()).toBe(true);
    const data = JSON.parse(await Bun.file(mcpPath).text()) as {
      mcpServers?: { miru?: unknown };
    };
    expect(data.mcpServers?.miru).toBeDefined();
  });

  test("T9: applyCaveman returns null when unsupported", async () => {
    const agent: AgentTarget = {
      ...claudeTarget(root),
      cavemanSkillPath: null,
    };
    expect(await applyCaveman(agent, "install")).toBeNull();
    expect(await applyCaveman(agent, "uninstall")).toBeNull();
    const caveman = INTEGRATIONS.find((entry) => entry.id === "caveman");
    expect(caveman?.planPath(agent)).toBeNull();
  });

  test("shared Caveman path: owners keep/remove across the full family", async () => {
    const { shared, ownersPath, family, copilot, vscode, visualstudio } =
      copilotFamilyTargets(root);
    const ctx = {
      selectedAgents: family,
      cavemanSeenPaths: new Set<string>(),
      steSeenPaths: new Set<string>(),
      allAgents: family,
    };

    expect((await applyCaveman(copilot, "install", ctx))?.action).toBe("created");
    expect((await applyCaveman(vscode, "install", ctx))?.action).toBe("unchanged");
    expect((await applyCaveman(visualstudio, "install", ctx))?.action).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual([
      "copilot",
      "visualstudio",
      "vscode",
    ]);

    expect(
      (
        await applyCaveman(vscode, "uninstall", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["copilot", "visualstudio"]);

    expect(
      (
        await applyCaveman(visualstudio, "uninstall", {
          selectedAgents: [visualstudio],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["copilot"]);

    expect(
      (
        await applyCaveman(copilot, "uninstall", {
          selectedAgents: [copilot],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(shared).exists()).toBe(false);
    expect(await Bun.file(ownersPath).exists()).toBe(false);
  });

  test("shared Caveman path: uninstalling all selected owners removes once", async () => {
    const { shared, family, copilot, vscode, visualstudio } = copilotFamilyTargets(root);
    const installCtx = {
      selectedAgents: family,
      cavemanSeenPaths: new Set<string>(),
      steSeenPaths: new Set<string>(),
      allAgents: family,
    };
    await applyCaveman(copilot, "install", installCtx);
    await applyCaveman(vscode, "install", installCtx);
    await applyCaveman(visualstudio, "install", installCtx);

    expect(
      (
        await applyCaveman(copilot, "uninstall", {
          selectedAgents: family,
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
        })
      )?.action,
    ).toBe("unchanged");
    expect(
      (
        await applyCaveman(vscode, "uninstall", {
          selectedAgents: family,
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
        })
      )?.action,
    ).toBe("unchanged");
    expect(
      (
        await applyCaveman(visualstudio, "uninstall", {
          selectedAgents: family,
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(shared).exists()).toBe(false);
  });

  test("shared Caveman path: legacy upgrade seeds siblings or stays on detect keep", async () => {
    const { shared, ownersPath, family, copilot, vscode } = copilotFamilyTargets(root);
    await mkdir(dirname(shared), { recursive: true });
    await Bun.write(shared, CAVEMAN_SKILL_MD);

    // No siblings detected → do not stamp a singleton owners file.
    await applyCaveman(vscode, "install", {
      selectedAgents: [vscode],
      cavemanSeenPaths: new Set(),
      steSeenPaths: new Set(),
      allAgents: family,
      isDetected: async () => false,
    });
    expect(await Bun.file(ownersPath).exists()).toBe(false);

    // Sibling detected on reinstall → seed owners and keep on vscode-only uninstall.
    expect(
      (
        await applyCaveman(vscode, "install", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async (agent) => agent.id === "copilot",
        })
      )?.action,
    ).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["copilot", "vscode"]);

    expect(
      (
        await applyCaveman(vscode, "uninstall", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["copilot"]);

    // Pure legacy (no owners): detect keep, then remove when no sibling remains.
    await unlink(ownersPath).catch(() => undefined);
    expect(
      (
        await applyCaveman(vscode, "uninstall", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: [copilot, vscode],
          isDetected: async (agent) => agent.id === "copilot",
        })
      )?.action,
    ).toBe("unchanged");

    expect(
      (
        await applyCaveman(vscode, "uninstall", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: [copilot, vscode],
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(shared).exists()).toBe(false);
  });

  test("shared Caveman path: cleans orphan owners when skill is already gone", async () => {
    const { shared, ownersPath, family, copilot } = copilotFamilyTargets(root);
    await mkdir(dirname(shared), { recursive: true });
    await Bun.write(ownersPath, '["copilot"]\n');

    expect(
      (
        await applyCaveman(copilot, "uninstall", {
          selectedAgents: [copilot],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(ownersPath).exists()).toBe(false);
  });

  test("shared Caveman path: empty owners file removes even if siblings are detected", async () => {
    const { shared, ownersPath, family, copilot } = copilotFamilyTargets(root);
    await mkdir(dirname(shared), { recursive: true });
    await Bun.write(shared, CAVEMAN_SKILL_MD);
    await Bun.write(ownersPath, "[]\n");

    expect(
      (
        await applyCaveman(copilot, "uninstall", {
          selectedAgents: [copilot],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => true,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(shared).exists()).toBe(false);
    expect(await Bun.file(ownersPath).exists()).toBe(false);
  });

  test("Codex Caveman install enables [features] skills = true", async () => {
    const configPath = join(root, ".codex", "config.toml");
    const skillPath = join(root, ".agents", "skills", "caveman", "SKILL.md");
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, 'model = "gpt-5"\n');

    const agent: AgentTarget = {
      ...claudeTarget(root),
      id: "codex",
      displayName: "Codex",
      cavemanSkillPath: skillPath,
      mcp: {
        path: configPath,
        key: "mcp_servers",
        memberKey: "miru",
        entry: {},
        format: "toml",
      },
      instructionsPath: null,
      subagentPath: null,
      subagentId: null,
    };

    expect((await applyCaveman(agent, "install"))?.action).toBe("created");
    expect(await Bun.file(skillPath).text()).toBe(CAVEMAN_SKILL_MD);
    const toml = await Bun.file(configPath).text();
    expect(toml).toContain("[features]");
    expect(toml).toMatch(/skills\s*=\s*true/);
    expect(toml).toContain('model = "gpt-5"');
    expect(codexSkillsFeatureEnabled(toml)).toBe(true);

    expect(await ensureCodexSkillsFeature(configPath)).toBe("unchanged");
    expect((await applyCaveman(agent, "install"))?.action).toBe("unchanged");

    // Uninstall removes the skill but leaves the Codex skills feature enabled.
    expect((await applyCaveman(agent, "uninstall"))?.action).toBe("removed");
    expect(await Bun.file(skillPath).exists()).toBe(false);
    expect(await Bun.file(configPath).text()).toMatch(/skills\s*=\s*true/);
  });

  test("ensureCodexSkillsFeature inserts into existing [features] and flips false", async () => {
    const configPath = join(root, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });

    await Bun.write(configPath, "[features]\napps = true\n");
    expect(await ensureCodexSkillsFeature(configPath)).toBe("updated");
    let text = await Bun.file(configPath).text();
    expect(text).toContain("[features]");
    expect(text).toMatch(/skills\s*=\s*true/);
    expect(text).toContain("apps = true");
    expect(await ensureCodexSkillsFeature(configPath)).toBe("unchanged");

    await Bun.write(configPath, "[features]\nskills = false\napps = true\n");
    expect(await ensureCodexSkillsFeature(configPath)).toBe("updated");
    text = await Bun.file(configPath).text();
    expect(text).toMatch(/skills\s*=\s*true/);
    expect(text).not.toMatch(/skills\s*=\s*false/);
    expect(text).toContain("apps = true");
  });

  test("codexCavemanPlanNote is honest about install vs uninstall", () => {
    expect(codexCavemanPlanNote("install", false)).toContain("also sets");
    expect(codexCavemanPlanNote("install", true)).toContain("also sets");
    expect(codexCavemanPlanNote("uninstall", false)).toBeNull();
    expect(codexCavemanPlanNote("uninstall", true)).toContain("leaves");
    expect(codexCavemanPlanNote("uninstall", true)).not.toContain("also sets");
  });

  test("T11: applySte installs shared agents skill + references", async () => {
    const skillDir = join(root, ".agents", "skills", "ste");
    const agent: AgentTarget = {
      ...claudeTarget(root),
      id: "cursor",
      displayName: "Cursor",
      steSkillDir: skillDir,
      mcp: null,
      instructionsPath: null,
      subagentPath: null,
      subagentId: null,
      cavemanSkillPath: null,
    };
    const result = await applySte(agent, "install");
    expect(result?.action).toBe("created");
    expect(result?.path).toBe(join(skillDir, "SKILL.md"));
    expect(await Bun.file(join(skillDir, "SKILL.md")).text()).toBe(STE_SKILL_MD);
    for (const file of STE_REFERENCE_FILES) {
      expect(await Bun.file(join(skillDir, file.relativePath)).text()).toBe(file.content);
    }
  });

  test("T11b: applySte reports unchanged when pack matches", async () => {
    const agent = claudeTarget(root);
    expect((await applySte(agent, "install"))?.action).toBe("created");
    expect((await applySte(agent, "install"))?.action).toBe("unchanged");
  });

  test("T12: applySte re-install updates skill pack", async () => {
    const agent = claudeTarget(root);
    expect((await applySte(agent, "install"))?.action).toBe("created");
    const skillPath = join(agent.steSkillDir ?? "", "SKILL.md");
    await Bun.write(skillPath, "stale\n");
    expect((await applySte(agent, "install"))?.action).toBe("updated");
    expect(await Bun.file(skillPath).text()).toBe(STE_SKILL_MD);
    for (const file of STE_REFERENCE_FILES) {
      expect(await Bun.file(join(agent.steSkillDir ?? "", file.relativePath)).exists()).toBe(true);
    }
  });

  test("T13: applySte uninstall removes Miru files; leaves MCP, Caveman, and user files", async () => {
    const agent = claudeTarget(root);
    await applyMcp(agent, "install");
    await applyCaveman(agent, "install");
    await applySte(agent, "install");
    const steDir = agent.steSkillDir ?? "";
    const mcpPath = agent.mcp?.path ?? "";
    const cavemanPath = agent.cavemanSkillPath ?? "";
    const userFile = join(steDir, "notes.md");
    await Bun.write(userFile, "Keep this file.\n");

    expect((await applySte(agent, "uninstall"))?.action).toBe("removed");
    expect(await Bun.file(join(steDir, "SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(steDir, "references", "rules.md")).exists()).toBe(false);
    expect(existsSync(userFile)).toBe(true);
    expect(await Bun.file(mcpPath).exists()).toBe(true);
    expect(await Bun.file(cavemanPath).exists()).toBe(true);
  });

  test("T14: applySte returns null when unsupported", async () => {
    const agent: AgentTarget = {
      ...claudeTarget(root),
      steSkillDir: null,
    };
    expect(await applySte(agent, "install")).toBeNull();
    expect(await applySte(agent, "uninstall")).toBeNull();
    const ste = INTEGRATIONS.find((entry) => entry.id === "ste");
    expect(ste?.planPath(agent)).toBeNull();
  });

  test("shared STE path: owners keep/remove across IDEs", async () => {
    const { skillPath, ownersPath, family, cursor, vscode, codex } = sharedSteFamilyTargets(root);
    const ctx = {
      selectedAgents: family,
      cavemanSeenPaths: new Set<string>(),
      steSeenPaths: new Set<string>(),
      allAgents: family,
    };

    expect((await applySte(cursor, "install", ctx))?.action).toBe("created");
    expect((await applySte(vscode, "install", ctx))?.action).toBe("unchanged");
    // Codex shares the path (deduped write) but still enables [features] skills.
    const codexInstall = await applySte(codex, "install", ctx);
    expect(codexInstall?.action).toBe("updated");
    expect(codexInstall?.note).toContain("skills = true");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["codex", "cursor", "vscode"]);

    expect(
      (
        await applySte(vscode, "uninstall", {
          selectedAgents: [vscode],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("unchanged");
    expect(JSON.parse(await Bun.file(ownersPath).text())).toEqual(["codex", "cursor"]);
    expect(await Bun.file(skillPath).exists()).toBe(true);

    expect(
      (
        await applySte(cursor, "uninstall", {
          selectedAgents: [cursor],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("unchanged");

    expect(
      (
        await applySte(codex, "uninstall", {
          selectedAgents: [codex],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(skillPath).exists()).toBe(false);
    expect(await Bun.file(ownersPath).exists()).toBe(false);
  });

  test("Codex STE install enables [features] skills = true", async () => {
    const { skillPath, codex } = sharedSteFamilyTargets(root);
    const configPath = codex.mcp?.path ?? "";
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, "");

    const result = await applySte(codex, "install");
    expect(result?.action).toBe("created");
    expect(result?.note).toContain("skills = true");
    expect(await Bun.file(skillPath).exists()).toBe(true);
    expect(await Bun.file(configPath).text()).toMatch(/skills\s*=\s*true/);
  });

  test("shared STE path: Codex enables skills when another IDE writes first", async () => {
    const { family, cursor, codex } = sharedSteFamilyTargets(root);
    const configPath = codex.mcp?.path ?? "";
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, "");

    const ctx = {
      selectedAgents: [cursor, codex],
      cavemanSeenPaths: new Set<string>(),
      steSeenPaths: new Set<string>(),
      allAgents: family,
    };
    expect((await applySte(cursor, "install", ctx))?.action).toBe("created");
    const second = await applySte(codex, "install", ctx);
    expect(second?.action).toBe("updated");
    expect(second?.note).toContain("shared skill path already written");
    expect(second?.note).toContain("skills = true");
    expect(await Bun.file(configPath).text()).toMatch(/skills\s*=\s*true/);
  });

  test("shared STE path: cleans orphan owners when skill is already gone", async () => {
    const { skillPath, ownersPath, family, cursor } = sharedSteFamilyTargets(root);
    await mkdir(dirname(skillPath), { recursive: true });
    await Bun.write(ownersPath, '["cursor"]\n');

    expect(
      (
        await applySte(cursor, "uninstall", {
          selectedAgents: [cursor],
          cavemanSeenPaths: new Set(),
          steSeenPaths: new Set(),
          allAgents: family,
          isDetected: async () => false,
        })
      )?.action,
    ).toBe("removed");
    expect(await Bun.file(ownersPath).exists()).toBe(false);
  });
});

describe("Copilot detection", () => {
  test("isCopilotInstalled ignores shared ~/.copilot skills root alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "miru-copilot-detect-"));
    try {
      expect(isCopilotInstalled(home)).toBe(false);

      await mkdir(join(home, ".copilot", "skills", "caveman"), { recursive: true });
      await Bun.write(join(home, ".copilot", "skills", "caveman", "SKILL.md"), "x\n");
      expect(isCopilotInstalled(home)).toBe(false);

      await Bun.write(join(home, ".copilot", "mcp-config.json"), "{}\n");
      expect(isCopilotInstalled(home)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("isCopilotInstalled accepts github-copilot config or agents dir", async () => {
    const home = await mkdtemp(join(tmpdir(), "miru-copilot-detect-"));
    try {
      await mkdir(join(home, ".config", "github-copilot"), { recursive: true });
      expect(isCopilotInstalled(home)).toBe(true);

      const home2 = await mkdtemp(join(tmpdir(), "miru-copilot-agents-"));
      try {
        await mkdir(join(home2, ".copilot", "agents"), { recursive: true });
        expect(isCopilotInstalled(home2)).toBe(true);
      } finally {
        await rm(home2, { recursive: true, force: true });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("uninstall local data cleanup", () => {
  test("removeUninstallLocalData deletes the global benchmark report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-uninstall-bench-"));
    const path = join(dir, "benchmark-history.json");
    const block: SearchBenchmarkBlock = {
      mode: true,
      token_count_method: "wordpiece",
      tokenizer_json: null,
      miru: {
        search_tokens: 10,
        workflow_tokens: 10,
        latency_ms: 1,
        top_file: "a.ts",
        top_files: ["a.ts"],
      },
      grep_read: {
        search_tokens: 5,
        read_full_tokens: 20,
        read_window_tokens: 8,
        workflow_full_tokens: 25,
        workflow_window_tokens: 13,
        latency_ms: 2,
        top_file: "a.ts",
        top_files: ["a.ts"],
        pattern: "a",
        keywords: ["a"],
      },
      efficiency: { token_savings_pct: 60, baseline: "grep_search_plus_read_full" },
      accuracy: { rank1_match: true, top_k_overlap_pct: 100, miru_only: [], grep_only: [] },
      overhead: { parallel_total_ms: 3, miru_share_ms: 1, grep_share_ms: 2 },
    };
    await appendBenchmarkQuery(recordFromBenchmark("/repo", block), { path });

    await runWithBenchmarkHistoryPath(path, async () => {
      const result = await removeUninstallLocalData();
      expect(result.benchmarkHistoryCleared).toBe(true);
      expect(result.benchmarkHistoryPath).toBe(path);
    });
    expect(await Bun.file(path).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("uninstall help mentions benchmark report cleanup", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      printCommandHelp("uninstall");
    } finally {
      process.stdout.write = original;
    }
    const text = chunks.join("");
    expect(text).toContain("benchmark report");
    expect(text).toContain("state directory");
  });

  test("benchmark help documents on/off exit path", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      printCommandHelp("benchmark");
    } finally {
      process.stdout.write = original;
    }
    const text = chunks.join("");
    expect(text).toContain("miru benchmark off");
    expect(text).toContain("miru benchmark on");
    expect(text).toContain("miru benchmark clear");
    expect(text).toContain("no env overrides");
    expect(text).toContain("plaintext");
    expect(text).toContain("JSONL");
    expect(text).toContain("Grep baseline");
  });
});
