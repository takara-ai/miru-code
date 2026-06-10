import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeClaudeHooks,
  mergeCursorHooks,
  mergeGeminiHooks,
  mergeHooks,
  mergeKiroHooks,
  mergeOpenCodePlugin,
  mergeVscodeHooks,
  mergeWindsurfHooks,
  removeHooks,
} from "../src/installer/hooks/install.ts";
import {
  evaluateSearchGuard,
  hookResponseFormat,
  isExplorationShell,
  isLiteralGrepPattern,
  isMcpDescriptorGlob,
  normalizeHookPayload,
  searchGuardBlockReason,
} from "../src/installer/hooks/search-guard.ts";

describe("search-guard", () => {
  test("blocks conceptual Grep with actionable reason", () => {
    const decision = evaluateSearchGuard({
      tool_name: "Grep",
      tool_input: { pattern: "authentication middleware" },
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain('search` with query "authentication middleware"');
    expect(decision.reason).toContain("expand");
    expect(decision.reason).toContain("truncated: true");
  });

  test("allows literal Grep", () => {
    const decision = evaluateSearchGuard({
      tool_name: "Grep",
      tool_input: { pattern: "REDIS_HOST" },
    });
    expect(decision.block).toBe(false);
  });

  test("allows Glob for MCP tool descriptor paths", () => {
    expect(
      evaluateSearchGuard({
        tool_name: "Glob",
        tool_input: { glob_pattern: "**/mcps/user-miru/tools/*.json" },
      }).block,
    ).toBe(false);
    expect(isMcpDescriptorGlob("**/mcps/user-miru/tools/*.json")).toBe(true);
  });

  test("blocks Glob, SemanticSearch, and Gemini grep_search", () => {
    expect(evaluateSearchGuard({ tool_name: "Glob", tool_input: {} }).block).toBe(true);
    expect(evaluateSearchGuard({ tool_name: "SemanticSearch", tool_input: {} }).block).toBe(true);
    expect(
      evaluateSearchGuard({
        tool_name: "grep_search",
        tool_input: { query: "how auth works" },
      }).block,
    ).toBe(true);
  });

  test("blocks Kiro grep and exploration shell", () => {
    expect(
      evaluateSearchGuard({
        hook_event_name: "preToolUse",
        tool_name: "grep",
        tool_input: { pattern: "authentication flow" },
      }).block,
    ).toBe(true);
    expect(
      evaluateSearchGuard({
        hook_event_name: "preToolUse",
        tool_name: "shell",
        tool_input: { command: "rg auth" },
      }).block,
    ).toBe(true);
  });

  test("normalizes Windsurf pre_run_command", () => {
    const payload = normalizeHookPayload({
      agent_action_name: "pre_run_command",
      tool_info: { command_line: "rg authentication" },
    });
    expect(payload.tool_name).toBe("Shell");
    expect(evaluateSearchGuard(payload).block).toBe(true);
    expect(hookResponseFormat(payload)).toBe("stderr");
  });

  test("allows build shell commands", () => {
    expect(isExplorationShell("npm test")).toBe(false);
    expect(isExplorationShell("git status")).toBe(false);
  });

  test("blocks ripgrep shell exploration", () => {
    expect(isExplorationShell("rg authentication")).toBe(true);
  });

  test("never blocks miru MCP tools", () => {
    const decision = evaluateSearchGuard({
      tool_name: "mcp__miru__search",
      tool_input: { query: "auth" },
    });
    expect(decision.block).toBe(false);
  });

  test("response format detection", () => {
    expect(hookResponseFormat({ hook_event_name: "PreToolUse" })).toBe("claude");
    expect(hookResponseFormat({ hook_event_name: "BeforeTool" })).toBe("gemini");
    expect(hookResponseFormat({ hook_event_name: "preToolUse" })).toBe("stderr");
    expect(hookResponseFormat({ tool_name: "Grep" })).toBe("cursor");
  });

  test("isLiteralGrepPattern recognizes symbols and env vars", () => {
    expect(isLiteralGrepPattern("processOrder")).toBe(true);
    expect(isLiteralGrepPattern("DATABASE_URL")).toBe(true);
    expect(isLiteralGrepPattern("how does auth work")).toBe(false);
  });

  test("searchGuardBlockReason embeds the blocked query", () => {
    const reason = searchGuardBlockReason("SemanticSearch", {
      query: "arrow key handling",
    });
    expect(reason).toContain("arrow key handling");
    expect(reason).toContain("expand");
  });
});

describe("hook install", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "miru-hooks-"));
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mergeCursorHooks creates preToolUse entry", async () => {
    const path = join(root, "hooks.json");
    expect(await mergeCursorHooks(path)).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      hooks: { preToolUse: Array<{ matcher: string; command: string }> };
    };
    expect(data.hooks.preToolUse[0]?.command).toContain("hook-guard");
  });

  test("mergeClaudeHooks creates PreToolUse entry", async () => {
    const path = join(root, "settings.json");
    expect(await mergeClaudeHooks(path)).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(data.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("hook-guard");
  });

  test("mergeGeminiHooks adds BeforeTool without clobbering mcpServers", async () => {
    const path = join(root, "settings.json");
    await Bun.write(path, JSON.stringify({ mcpServers: { miru: { command: "bunx" } } }, null, 2));
    expect(await mergeGeminiHooks(path)).toBe("updated");
    const data = JSON.parse(await Bun.file(path).text()) as {
      mcpServers: Record<string, unknown>;
      hooks: { BeforeTool: Array<{ matcher: string }> };
    };
    expect(data.mcpServers.miru).toBeDefined();
    expect(data.hooks.BeforeTool[0]?.matcher).toContain("grep_search");
  });

  test("mergeVscodeHooks writes standalone copilot hook file", async () => {
    const path = join(root, "hooks", "miru-search.json");
    expect(await mergeVscodeHooks(path)).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      hooks: { PreToolUse: Array<{ command: string }> };
    };
    expect(data.hooks.PreToolUse[0]?.command).toContain("hook-guard");
  });

  test("mergeKiroHooks adds preToolUse matchers", async () => {
    const path = join(root, "kiro-hooks.json");
    expect(await mergeKiroHooks(path)).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      hooks: { preToolUse: Array<{ matcher: string }> };
    };
    expect(data.hooks.preToolUse.length).toBe(3);
  });

  test("mergeWindsurfHooks adds pre_run_command", async () => {
    const path = join(root, "windsurf-hooks.json");
    expect(await mergeWindsurfHooks(path)).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      hooks: { pre_run_command: Array<{ command: string }> };
    };
    expect(data.hooks.pre_run_command[0]?.command).toContain("hook-guard");
  });

  test("mergeOpenCodePlugin copies plugin file", async () => {
    const path = join(root, "plugins", "miru-search-guard.ts");
    expect(await mergeOpenCodePlugin(path)).toBe("created");
    const text = await Bun.file(path).text();
    expect(text).toContain("tool.execute.before");
  });

  test("mergeHooks and removeHooks round-trip codex format", async () => {
    const path = join(root, "codex-hooks.json");
    expect(await mergeHooks("claude", path)).toBe("created");
    expect(await removeHooks("claude", path)).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("remove hooks strips miru entries only", async () => {
    const cursorPath = join(root, "cursor-hooks.json");
    await mergeCursorHooks(cursorPath);
    expect(await removeHooks("cursor", cursorPath)).toBe("removed");
    expect(await Bun.file(cursorPath).exists()).toBe(false);
  });
});
