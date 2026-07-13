import { describe, expect, test } from "bun:test";
import { loadAgentTemplate } from "../src/agents.ts";
import {
  buildSubagentBody,
  MCP_BENCHMARK_SERVER_INSTRUCTIONS,
  MCP_LOCATE_TOOL_DESCRIPTION,
  MCP_READ_BENCHMARK_TOOL_DESCRIPTION,
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
    expect(MCP_SEARCH_TOOL_DESCRIPTION).toContain("locate");
    expect(MCP_SEARCH_TOOL_DESCRIPTION).not.toContain("NOT only for large explorations");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("default for all code search queries");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("`locate`");
    expect(MCP_LOCATE_TOOL_DESCRIPTION).toContain("Exact substring");
  });

  test("benchmark instructions and read_benchmark description stay compact", () => {
    expect(MCP_BENCHMARK_SERVER_INSTRUCTIONS).toContain("read_benchmark");
    expect(MCP_BENCHMARK_SERVER_INSTRUCTIONS).toContain("Do not narrate benchmark stats");
    expect(MCP_BENCHMARK_SERVER_INSTRUCTIONS).toContain("save_pct");
    expect(MCP_BENCHMARK_SERVER_INSTRUCTIONS).toContain("`search` and `locate`");
    expect(MCP_BENCHMARK_SERVER_INSTRUCTIONS).toContain("miru benchmark off");
    expect(MCP_READ_BENCHMARK_TOOL_DESCRIPTION).toContain("{n,saved,save_pct,miru,grep}");
    expect(MCP_READ_BENCHMARK_TOOL_DESCRIPTION).toContain("`search` and `locate`");
    expect(MCP_READ_BENCHMARK_TOOL_DESCRIPTION).toContain("Do not call unless the user asks");
  });
});
