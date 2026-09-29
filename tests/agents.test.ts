import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentId,
  agentDestination,
  loadAgentTemplate,
  writeAgentFile,
} from "../src/agents.ts";

describe("agent templates", () => {
  test("loads all built-in agent instructions and maps Copilot to its GitHub folder", async () => {
    const agents: AgentId[] = ["claude", "copilot", "cursor", "gemini", "kiro", "opencode"];
    for (const agent of agents) {
      const template = await loadAgentTemplate(agent);
      expect(template.length).toBeGreaterThan(100);
      expect(template.endsWith("\n")).toBe(true);
      expect(agentDestination(agent)).toContain(
        join(agent === "copilot" ? ".github" : `.${agent}`, "agents"),
      );
    }
  });

  test("refuses an existing file unless force is set and writes into the requested directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "miru-agent-test-"));
    try {
      const target = agentDestination("claude", cwd);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, "existing");
      await expect(writeAgentFile("claude", { cwd })).rejects.toThrow("already exists");
      expect(await writeAgentFile("claude", { cwd, force: true })).toBe(target);
      expect(await Bun.file(target).text()).toContain("name: miru-code");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
