import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTarget } from "../src/installer/agents.ts";
import {
  applyMcp,
  applySubagent,
  type RunInstallerDependencies,
  runInstaller,
} from "../src/installer/installer.ts";

function target(root: string): AgentTarget {
  return {
    id: "claude",
    displayName: "Test Agent",
    binary: null,
    configDir: null,
    mcp: {
      path: join(root, "settings.json"),
      key: "mcpServers",
      memberKey: "miru",
      entry: { command: "bunx", args: ["miru"] },
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
}

function mcpPath(agent: AgentTarget): string {
  const path = agent.mcp?.path;
  if (!path) throw new Error("test target must support MCP");
  return path;
}

function workflowDependencies(
  agent: AgentTarget,
  selected: boolean,
  proceed = true,
): RunInstallerDependencies {
  return {
    requireInteractiveTerminal: () => {},
    ensureCredentials: async () => {},
    agents: [agent],
    isAgentDetected: async () => true,
    promptMultiSelect: async <T>(
      title: string,
      items: Array<{ label: string; value: T; checked: boolean }>,
    ) => {
      if (!selected) return [];
      if (title.startsWith("Agents")) return [agent as T];
      return items.filter((item) => item.label.startsWith("MCP server")).map((item) => item.value);
    },
    promptConfirm: async () => proceed,
  };
}

describe("installer workflow", () => {
  test("installs the selected MCP integration after planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-flow-"));
    try {
      const agent = target(root);
      await runInstaller("install", workflowDependencies(agent, true));
      const config = JSON.parse(await Bun.file(mcpPath(agent)).text());
      expect(config.mcpServers.miru.args).toEqual(["miru"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs and uninstalls every supported integration through the interactive workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-all-integrations-"));
    try {
      const agent: AgentTarget = {
        ...target(root),
        instructionsPath: join(root, "CLAUDE.md"),
        cursorRulesPath: join(root, "rules.mdc"),
        hooksPath: join(root, "hooks.json"),
        hooksFormat: "claude",
        subagentPath: join(root, "subagent.md"),
        subagentId: "claude",
        cavemanSkillPath: join(root, "skills", "caveman", "SKILL.md"),
        steSkillDir: join(root, "skills", "ste"),
      };
      const allSelected: RunInstallerDependencies = {
        ...workflowDependencies(agent, true),
        promptMultiSelect: async <T>(title: string, items: Array<{ value: T; label: string }>) =>
          title.startsWith("Agents") ? [agent as T] : items.map((item) => item.value),
      };

      await runInstaller("install", allSelected);
      expect(await Bun.file(agent.instructionsPath as string).exists()).toBe(true);
      expect(await Bun.file(agent.cursorRulesPath as string).exists()).toBe(true);
      expect(await Bun.file(agent.hooksPath as string).exists()).toBe(true);
      expect(await Bun.file(agent.subagentPath as string).exists()).toBe(true);
      expect(await Bun.file(agent.cavemanSkillPath as string).exists()).toBe(true);
      expect(await Bun.file(join(agent.steSkillDir as string, "SKILL.md")).exists()).toBe(true);

      await runInstaller("install", allSelected); // existing configs and complete skill packs

      await runInstaller("uninstall", {
        ...allSelected,
        removeUninstallLocalData: async () => ({
          benchmarkHistoryCleared: false,
          benchmarkHistoryPath: "",
        }),
      });
      expect(await Bun.file(agent.instructionsPath as string).exists()).toBe(false);
      expect(await Bun.file(agent.cursorRulesPath as string).exists()).toBe(false);
      expect(await Bun.file(agent.subagentPath as string).exists()).toBe(false);
      expect(await Bun.file(agent.cavemanSkillPath as string).exists()).toBe(false);
      expect(await Bun.file(join(agent.steSkillDir as string, "SKILL.md")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns when nothing is selected or when the user cancels the plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-flow-"));
    try {
      const agent = target(root);
      await runInstaller("install", workflowDependencies(agent, false));
      await runInstaller("install", workflowDependencies(agent, true, false));
      expect(await Bun.file(mcpPath(agent)).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns when selected agents or integrations have no applicable actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-no-applicable-"));
    try {
      const agent = {
        ...target(root),
        mcp: null,
      };
      await runInstaller("install", {
        ...workflowDependencies(agent, true),
        promptMultiSelect: async <T>(title: string) =>
          title.startsWith("Agents") ? [agent as T] : [],
      });
      await runInstaller("install", {
        ...workflowDependencies(target(root), true),
        promptMultiSelect: async <T>(title: string, _items: Array<{ value: T }>) =>
          title.startsWith("Agents") ? [target(root) as T] : [],
      });
      const mcpAgent = target(root);
      await runInstaller("install", {
        ...workflowDependencies(mcpAgent, true),
        promptMultiSelect: async <T>(title: string, _items: Array<{ value: T }>) =>
          title.startsWith("Agents") ? [mcpAgent as T] : [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("handles unsupported MCP targets and missing subagent templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-error-actions-"));
    try {
      const agent = target(root);
      expect(await applyMcp({ ...agent, mcp: null }, "install")).toBeNull();
      const invalid = {
        ...agent,
        subagentPath: join(root, "agents", "missing.md"),
        subagentId: "missing-template" as AgentTarget["subagentId"],
      };
      expect(await applySubagent(invalid, "install")).toMatchObject({ action: "error" });
      expect(await applySubagent(invalid, "uninstall")).toMatchObject({ action: "not-found" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uninstalls the chosen MCP integration and reports cleared global history", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-installer-flow-"));
    try {
      const agent = target(root);
      await Bun.write(
        mcpPath(agent),
        JSON.stringify({ mcpServers: { miru: { command: "miru" } } }),
      );
      await runInstaller("uninstall", {
        ...workflowDependencies(agent, true),
        removeUninstallLocalData: async () => ({
          benchmarkHistoryCleared: true,
          benchmarkHistoryPath: "history.json",
        }),
      });
      expect(await Bun.file(mcpPath(agent)).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
