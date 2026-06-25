import { describe, expect, test } from "bun:test";
import { loadAgentTemplate } from "../src/agents.ts";
import {
  buildSubagentBody,
  MCP_SEARCH_TOOL_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
  SEARCH_GUARD_EXPAND_HINT,
  SNIPPET_GUIDANCE,
} from "../src/installer/search-policy.ts";

describe("search-policy", () => {
  test("snippet guidance documents truncated field and anchor_line", () => {
    expect(SNIPPET_GUIDANCE).toContain("truncated: true");
    expect(SNIPPET_GUIDANCE).toContain("anchor_line");
    expect(MCP_SERVER_INSTRUCTIONS).toContain(SNIPPET_GUIDANCE);
    expect(SEARCH_GUARD_EXPAND_HINT).toContain("truncated: true");
  });

  test("all agent templates include unified snippet workflow", async () => {
    const agents = ["claude", "cursor", "copilot", "gemini", "kiro", "opencode"] as const;
    for (const agent of agents) {
      const template = await loadAgentTemplate(agent);
      expect(template).toContain("truncated: true");
      expect(template).toContain("anchor_line");
      expect(template).toContain("find_related");
    }
  });

  test("copilot template uses host-native tool names", async () => {
    const template = await loadAgentTemplate("copilot");
    expect(template).toContain("grep_search");
    expect(template).toContain("read_file");
    expect(
      buildSubagentBody({
        explorationDenied: "grep_search",
        grep: "grep_search",
        read: "read_file",
      }),
    ).toContain("grep_search");
  });

  test("MCP search description positions Miru as the default for all code search", () => {
    expect(MCP_SEARCH_TOOL_DESCRIPTION).toContain("default search for all code search queries");
    expect(MCP_SEARCH_TOOL_DESCRIPTION).toContain("best, fastest, and cheapest");
    expect(MCP_SEARCH_TOOL_DESCRIPTION).toContain("better than");
    expect(MCP_SEARCH_TOOL_DESCRIPTION).not.toContain("NOT only for large explorations");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("default for all code search queries");
  });
});
