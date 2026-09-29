import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookInstallTestUtils,
  mergeClaudeHooks,
  mergeCursorHooks,
  mergeGeminiHooks,
  mergeHooks,
  mergeKiroHooks,
  mergeOpenCodePlugin,
  mergeVscodeHooks,
  mergeWindsurfHooks,
  removeClaudeHooks,
  removeCursorHooks,
  removeGeminiHooks,
  removeHooks,
  removeKiroHooks,
  removeOpenCodePlugin,
  removeVscodeHooks,
  removeWindsurfHooks,
  resolveHookCommand,
} from "../src/installer/hooks/install.ts";
import {
  claudeHookResponse,
  cursorHookResponse,
  evaluateSearchGuard,
  geminiHookResponse,
  hookResponseFormat,
  isExplorationShell,
  isLiteralGrepPattern,
  isMcpDescriptorGlob,
  normalizeHookPayload,
  runSearchGuardFromStdin,
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

  test("redirects literal Grep to Miru locate", () => {
    const decision = evaluateSearchGuard({
      tool_name: "Grep",
      tool_input: { pattern: "REDIS_HOST" },
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain('locate` with literal "REDIS_HOST"');
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
    expect(
      evaluateSearchGuard({ tool_name: "Shell", tool_input: { command: "npm test" } }),
    ).toEqual({ block: false, reason: "" });
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
    expect(isLiteralGrepPattern("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("searchGuardBlockReason embeds the blocked query", () => {
    const reason = searchGuardBlockReason("SemanticSearch", {
      query: "arrow key handling",
    });
    expect(reason).toContain("arrow key handling");
    expect(reason).toContain("expand");
    expect(searchGuardBlockReason("Grep", {})).toContain("your question about how the code works");
    expect(searchGuardBlockReason("Glob", { pattern: "*.ts" })).toContain("files matching *.ts");
    expect(searchGuardBlockReason("Shell", {})).toContain("your question about how the code works");
  });

  test("covers literal, shell, descriptor, and payload normalization edges", () => {
    expect(isLiteralGrepPattern("  `path.with spaces`  ")).toBe(true);
    expect(isLiteralGrepPattern("a".repeat(49))).toBe(false);
    expect(isLiteralGrepPattern(" ")).toBe(false);
    expect(isExplorationShell("  ")).toBe(false);
    expect(isExplorationShell("find src -name '*.ts'")).toBe(true);
    expect(isExplorationShell("python -m pytest tests")).toBe(false);
    expect(isMcpDescriptorGlob("C:\\repo\\mcps\\tools\\**")).toBe(true);
    expect(isMcpDescriptorGlob("**/mcps/user/tools/*.json")).toBe(true);
    expect(isMcpDescriptorGlob("src/**/*.ts")).toBe(false);
    expect(normalizeHookPayload({ tool_name: 42, tool_input: [], tool_info: [] })).toEqual({
      tool_name: undefined,
      tool_input: {},
      hook_event_name: undefined,
      agent_action_name: undefined,
      tool_info: undefined,
    });
    expect(normalizeHookPayload({ agent_action_name: "pre_run_command", tool_info: [] })).toEqual({
      hook_event_name: "windsurf_pre_run_command",
      tool_name: "Shell",
      tool_input: { command: "" },
    });
    expect(normalizeHookPayload({ agent_action_name: "post_run_command" })).toMatchObject({
      agent_action_name: "post_run_command",
    });
    expect(hookResponseFormat({ hook_event_name: "windsurf_pre_run_command" })).toBe("stderr");
  });

  test("builds responses and routes stdin guard decisions by host format", async () => {
    const reason = "use Miru";
    expect(JSON.parse(claudeHookResponse(reason))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason },
    });
    expect(JSON.parse(geminiHookResponse(reason))).toEqual({ decision: "deny", reason });
    expect(JSON.parse(cursorHookResponse(reason))).toMatchObject({
      permission: "deny",
      agent_message: reason,
    });

    expect(
      await runSearchGuardFromStdin({
        stdout: { write: () => true },
        stderr: { write: () => true },
      }),
    ).toBe(0);

    const call = async (raw: string) => {
      let stdout = "";
      let stderr = "";
      const code = await runSearchGuardFromStdin({
        readText: async () => raw,
        stdout: {
          write: (text) => {
            stdout += text;
            return true;
          },
        },
        stderr: {
          write: (text) => {
            stderr += text;
            return true;
          },
        },
      });
      return { code, stdout, stderr };
    };
    expect(await call("  ")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await call("invalid json")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await call(JSON.stringify({ tool_name: "Read" }))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const claude = await call(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "auth" },
      }),
    );
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const gemini = await call(JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "Glob" }));
    expect(gemini.code).toBe(0);
    expect(JSON.parse(gemini.stdout).decision).toBe("deny");
    const cursor = await call(JSON.stringify({ hook_event_name: "unknown", tool_name: "Glob" }));
    expect(cursor.code).toBe(2);
    expect(JSON.parse(cursor.stdout).permission).toBe("deny");
    const stderr = await call(
      JSON.stringify({
        hook_event_name: "preToolUse",
        tool_name: "grep",
        tool_input: { pattern: "auth" },
      }),
    );
    expect(stderr.code).toBe(2);
    expect(stderr.stderr).toContain("Miru");
  });
});

describe("hook install", () => {
  test("recognizes empty hook config shapes", () => {
    expect(hookInstallTestUtils.isEmptyHookConfig({})).toBe(true);
    expect(hookInstallTestUtils.isEmptyHookConfig({ version: 1 })).toBe(true);
    expect(hookInstallTestUtils.isEmptyHookConfig({ version: 1, name: "user" })).toBe(false);
    expect(hookInstallTestUtils.isEmptyHookConfig({ hooks: null })).toBe(false);
    expect(hookInstallTestUtils.isEmptyHookConfig({ hooks: "invalid" })).toBe(false);
    expect(hookInstallTestUtils.isEmptyHookConfig({ hooks: [] })).toBe(false);
    expect(hookInstallTestUtils.isEmptyHookConfig({ hooks: {} })).toBe(true);
    expect(hookInstallTestUtils.isEmptyHookConfig({ hooks: { PreToolUse: [] } })).toBe(false);
  });

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
    expect(await mergeVscodeHooks(path, "vscode")).toBe("created");
    const data = JSON.parse(await Bun.file(path).text()) as {
      miruOwners: string[];
      hooks: { PreToolUse: Array<{ command: string }> };
    };
    expect(data.hooks.PreToolUse[0]?.command).toContain("hook-guard");
    expect(data.miruOwners).toContain("vscode");
  });

  test("shared VS Code hooks honor ownership on uninstall", async () => {
    const path = join(root, "hooks", "miru-search.json");
    expect(await mergeVscodeHooks(path, "vscode")).toBe("created");
    expect(await mergeVscodeHooks(path, "copilot")).toBe("updated");

    expect(await removeHooks("vscode", path, "vscode")).toBe("updated");
    const retained = JSON.parse(await Bun.file(path).text()) as { miruOwners: string[] };
    expect(retained.miruOwners).toEqual(["copilot"]);

    expect(await removeHooks("vscode", path, "copilot")).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
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

  test("all hook mergers are idempotent and removers tolerate absent or invalid configs", async () => {
    const cases = [
      ["claude", mergeClaudeHooks, removeClaudeHooks],
      ["cursor", mergeCursorHooks, removeCursorHooks],
      ["gemini", mergeGeminiHooks, removeGeminiHooks],
      ["kiro", mergeKiroHooks, removeKiroHooks],
      ["windsurf", mergeWindsurfHooks, removeWindsurfHooks],
    ] as const;
    for (const [name, merge, remove] of cases) {
      const path = join(root, `${name}.json`);
      expect(await merge(path)).toBe("created");
      expect(await merge(path)).toBe("unchanged");
      expect(await remove(path)).toBe("removed");
      expect(await remove(path)).toBe("not-found");
    }

    const invalid = join(root, "invalid.json");
    await Bun.write(invalid, "not-json");
    expect(await mergeClaudeHooks(invalid)).toBe("error");
    expect(await removeClaudeHooks(invalid)).toBe("error");
    await Bun.write(invalid, JSON.stringify({ hooks: [] }));
    expect(await removeClaudeHooks(invalid)).toBe("not-found");
    await Bun.write(invalid, JSON.stringify({ hooks: "invalid" }));
    expect(await removeClaudeHooks(invalid)).toBe("not-found");
    await Bun.write(invalid, JSON.stringify({ hooks: null }));
    expect(await removeClaudeHooks(invalid)).toBe("not-found");
    await Bun.write(invalid, JSON.stringify({ unrelated: true }));
    expect(await removeClaudeHooks(invalid)).toBe("not-found");
    expect(await removeCursorHooks(join(root, "missing.json"))).toBe("not-found");
  });

  test("Cursor and VS Code replace existing Miru hooks while preserving user hooks", async () => {
    const cursor = join(root, "cursor-existing.json");
    await Bun.write(
      cursor,
      JSON.stringify({
        version: 4,
        hooks: {
          preToolUse: [
            { command: "miru hook-guard old", matcher: "old" },
            { command: "user command", matcher: "*" },
          ],
        },
      }),
    );
    expect(await mergeCursorHooks(cursor)).toBe("updated");
    expect(await mergeCursorHooks(cursor)).toBe("unchanged");
    expect(JSON.parse(await Bun.file(cursor).text()).version).toBe(4);

    const vscode = join(root, "vscode-existing.json");
    await Bun.write(
      vscode,
      JSON.stringify({
        miruOwners: ["vscode", "unknown", 2],
        hooks: { PreToolUse: [{ command: "miru hook-guard old" }, { command: "user" }] },
      }),
    );
    expect(await mergeVscodeHooks(vscode, "copilot")).toBe("updated");
    expect(await mergeVscodeHooks(vscode, "copilot")).toBe("unchanged");
    expect(await removeVscodeHooks(vscode, "copilot")).toBe("updated");
    expect(await removeVscodeHooks(vscode, "vscode")).toBe("removed");
    expect(await Bun.file(vscode).exists()).toBe(true);
    expect(JSON.parse(await Bun.file(vscode).text()).hooks.PreToolUse).toEqual([
      { command: "user" },
    ]);
  });

  test("VS Code removes only marked configs and OpenCode plugin updates idempotently", async () => {
    const vscode = join(root, "vscode-user.json");
    await Bun.write(vscode, JSON.stringify({ mcpServers: { miru: { command: "bunx" } } }));
    expect(await removeVscodeHooks(vscode)).toBe("not-found");
    await Bun.write(vscode, JSON.stringify({ hooks: { PreToolUse: [{ command: "user" }] } }));
    expect(await removeVscodeHooks(vscode)).toBe("not-found");

    const plugin = join(root, "plugins", "miru.ts");
    expect(await mergeOpenCodePlugin(plugin)).toBe("created");
    expect(await mergeOpenCodePlugin(plugin)).toBe("unchanged");
    await Bun.write(plugin, "old content");
    expect(await mergeOpenCodePlugin(plugin)).toBe("updated");
    expect(await removeOpenCodePlugin(plugin)).toBe("removed");
    expect(await removeOpenCodePlugin(plugin)).toBe("not-found");
  });

  test("resolves a shell-safe hook command", () => {
    expect(resolveHookCommand()).toContain("hook-guard");
  });

  test("quotes hook commands and handles CLI entry paths without an argv entry", () => {
    const original = process.argv[1];
    try {
      process.argv[1] = join(root, "miru tool's entry.ts");
      expect(resolveHookCommand()).toContain("bun run '");
      expect(resolveHookCommand()).toContain("'\\''");
      process.argv[1] = join(root, "miru tool");
      expect(resolveHookCommand()).toMatch(/^'.*' hook-guard$/);
      process.argv[1] = "";
      expect(resolveHookCommand()).toBe("miru hook-guard");
    } finally {
      if (original === undefined) process.argv.splice(1, 1);
      else process.argv[1] = original;
    }
  });

  test("covers wrapper dispatch for every supported hook host", async () => {
    const formats = [
      "cursor",
      "claude",
      "gemini",
      "vscode",
      "kiro",
      "windsurf",
      "opencode",
    ] as const;
    for (const format of formats) {
      const path = join(root, `${format}-dispatch.json`);
      expect(await mergeHooks(format, path, "vscode")).toBe("created");
      expect(await removeHooks(format, path, "vscode")).toBe("removed");
    }
  });

  test("handles malformed shapes and preserves user hooks on removal", async () => {
    const emptyArrayHooks = join(root, "empty-array-hooks.json");
    await Bun.write(emptyArrayHooks, JSON.stringify({ hooks: [] }));
    expect(await removeClaudeHooks(emptyArrayHooks)).toBe("not-found");
    const malformed = join(root, "malformed-shape.json");
    await Bun.write(malformed, JSON.stringify({ hooks: { PreToolUse: [{ hooks: "bad" }] } }));
    expect(await mergeClaudeHooks(malformed)).toBe("updated");
    const claude = JSON.parse(await Bun.file(malformed).text());
    claude.hooks.PreToolUse.push({ hooks: [{ command: "user command" }] });
    await Bun.write(malformed, JSON.stringify(claude));
    expect(await removeClaudeHooks(malformed)).toBe("removed");
    const remaining = JSON.parse(await Bun.file(malformed).text());
    expect(remaining.hooks.PreToolUse).toEqual([
      { hooks: "bad" },
      { hooks: [{ command: "user command" }] },
    ]);
    expect(await removeClaudeHooks(malformed)).toBe("not-found");

    for (const [name, merge] of [
      ["cursor", mergeCursorHooks],
      ["vscode", mergeVscodeHooks],
      ["kiro", mergeKiroHooks],
    ] as const) {
      const invalid = join(root, `invalid-${name}.json`);
      await Bun.write(invalid, "[]");
      expect(await merge(invalid)).toBe("error");
    }
    const invalidVscode = join(root, "invalid-vscode-remove.json");
    await Bun.write(invalidVscode, "{oops");
    expect(await removeVscodeHooks(invalidVscode)).toBe("error");
  });

  test("removes legacy VS Code marker files and handles missing hook files", async () => {
    const missing = join(root, "not-created.json");
    expect(await removeVscodeHooks(missing)).toBe("not-found");
    const legacy = join(root, "legacy-vscode.json");
    await Bun.write(
      legacy,
      JSON.stringify({ hooks: { PreToolUse: [{ command: "miru hook-guard" }] } }),
    );
    expect(await removeVscodeHooks(legacy)).toBe("removed");
    expect(await Bun.file(legacy).exists()).toBe(false);
    expect(await mergeCursorHooks(legacy)).toBe("created");
    await Bun.write(legacy, JSON.stringify({ hooks: { preToolUse: 42 } }));
    expect(await removeCursorHooks(legacy)).toBe("not-found");
  });
});
