import { SEARCH_GUARD_EXPAND_HINT } from "../search-policy.ts";

const REDIRECT_PREFIX =
  "Use Miru MCP instead of built-in search tools (pass project root as `repo`). " +
  "Grep/Glob/Shell are only for exact literal confirmation or non-code tasks.";

const MIRU_TOOL_RE = /miru/i;

const GREP_TOOL_RE = /^(grep|grep_search|Grep)$/i;
const GLOB_TOOL_RE = /^(glob|glob_file_search|Glob)$/i;
const SEMANTIC_TOOL_RE = /^(SemanticSearch|codebase_search)$/i;
const SHELL_TOOL_RE = /^(Shell|Bash|execute_bash|shell)$/i;

/** Returns true when a grep pattern looks like an exact literal lookup. */
export function isLiteralGrepPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[`'"][^`'"]+[`'"]$/.test(trimmed)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed)) {
    return true;
  }
  if (/^[a-f0-9-]{36}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed) && trimmed.length <= 48) {
    return true;
  }
  return false;
}

/** Shell commands that look like codebase exploration rather than builds/tests. */
export function isExplorationShell(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) {
    return false;
  }
  if (
    /\b(git|npm|bun|pnpm|yarn|cargo|go|make|cmake|docker|kubectl|pytest|jest|vitest)\b/.test(cmd)
  ) {
    return false;
  }
  return /\b(rg|ripgrep|grep|find|ag|ack|fd|locate)\b/.test(cmd);
}

export type HookPayload = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
  agent_action_name?: string;
  tool_info?: Record<string, unknown>;
};

export type GuardDecision = {
  block: boolean;
  reason: string;
};

export type HookResponseFormat = "claude" | "gemini" | "cursor" | "stderr";

function grepPatternFromInput(toolInput: Record<string, unknown>): string {
  return String(
    toolInput.pattern ??
      toolInput.query ??
      toolInput.regex ??
      toolInput.needle ??
      toolInput.search_term ??
      "",
  );
}

function globPatternFromInput(toolInput: Record<string, unknown>): string {
  return String(
    toolInput.glob_pattern ?? toolInput.pattern ?? toolInput.glob ?? toolInput.path ?? "",
  );
}

/** MCP tool descriptor paths are not codebase exploration. */
export function isMcpDescriptorGlob(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/mcps/") ||
    normalized.includes("mcps/**/tools") ||
    /\/mcps\/[^/]+\/tools/.test(normalized)
  );
}

function suggestedMiruQuery(toolName: string, toolInput: Record<string, unknown>): string {
  if (GREP_TOOL_RE.test(toolName) || toolName.toLowerCase() === "grep_search") {
    const pattern = grepPatternFromInput(toolInput).trim();
    if (pattern) {
      return pattern;
    }
  }
  if (GLOB_TOOL_RE.test(toolName)) {
    const pattern = globPatternFromInput(toolInput).trim();
    if (pattern) {
      return `files matching ${pattern}`;
    }
  }
  if (SEMANTIC_TOOL_RE.test(toolName)) {
    const query = String(toolInput.query ?? toolInput.search_term ?? "").trim();
    if (query) {
      return query;
    }
  }
  if (SHELL_TOOL_RE.test(toolName)) {
    const command = String(toolInput.command ?? toolInput.cmd ?? "").trim();
    if (command) {
      return command;
    }
  }
  return "your question about how the code works";
}

export function searchGuardBlockReason(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const query = suggestedMiruQuery(toolName, toolInput);
  return `${REDIRECT_PREFIX} Try Miru \`search\` with query "${query}". ${SEARCH_GUARD_EXPAND_HINT}`;
}

/** Map host-specific stdin JSON into a common evaluation shape. */
export function normalizeHookPayload(raw: Record<string, unknown>): HookPayload {
  const agentAction = raw.agent_action_name;
  if (typeof agentAction === "string") {
    const toolInfo =
      raw.tool_info && typeof raw.tool_info === "object" && !Array.isArray(raw.tool_info)
        ? (raw.tool_info as Record<string, unknown>)
        : {};
    if (agentAction === "pre_run_command") {
      return {
        hook_event_name: "windsurf_pre_run_command",
        tool_name: "Shell",
        tool_input: { command: toolInfo.command_line ?? "" },
      };
    }
  }

  return {
    tool_name: typeof raw.tool_name === "string" ? raw.tool_name : undefined,
    tool_input:
      raw.tool_input && typeof raw.tool_input === "object" && !Array.isArray(raw.tool_input)
        ? (raw.tool_input as Record<string, unknown>)
        : {},
    hook_event_name: typeof raw.hook_event_name === "string" ? raw.hook_event_name : undefined,
    agent_action_name:
      typeof raw.agent_action_name === "string" ? raw.agent_action_name : undefined,
    tool_info:
      raw.tool_info && typeof raw.tool_info === "object" && !Array.isArray(raw.tool_info)
        ? (raw.tool_info as Record<string, unknown>)
        : undefined,
  };
}

export function evaluateSearchGuard(payload: HookPayload): GuardDecision {
  const toolName = String(payload.tool_name ?? "");
  const toolInput = payload.tool_input ?? {};

  if (!toolName || MIRU_TOOL_RE.test(toolName)) {
    return { block: false, reason: "" };
  }

  if (GREP_TOOL_RE.test(toolName)) {
    const pattern = grepPatternFromInput(toolInput);
    if (isLiteralGrepPattern(pattern)) {
      return { block: false, reason: "" };
    }
    return { block: true, reason: searchGuardBlockReason(toolName, toolInput) };
  }

  if (GLOB_TOOL_RE.test(toolName)) {
    const pattern = globPatternFromInput(toolInput);
    if (isMcpDescriptorGlob(pattern)) {
      return { block: false, reason: "" };
    }
    return { block: true, reason: searchGuardBlockReason(toolName, toolInput) };
  }

  if (SEMANTIC_TOOL_RE.test(toolName)) {
    return { block: true, reason: searchGuardBlockReason(toolName, toolInput) };
  }

  if (SHELL_TOOL_RE.test(toolName)) {
    const command = String(toolInput.command ?? toolInput.cmd ?? "");
    if (isExplorationShell(command)) {
      return { block: true, reason: searchGuardBlockReason(toolName, toolInput) };
    }
    return { block: false, reason: "" };
  }

  return { block: false, reason: "" };
}

export function hookResponseFormat(payload: HookPayload): HookResponseFormat {
  const event = payload.hook_event_name ?? "";
  if (event === "PreToolUse") {
    return "claude";
  }
  if (event === "BeforeTool") {
    return "gemini";
  }
  if (event === "preToolUse" || event === "windsurf_pre_run_command") {
    return "stderr";
  }
  return "cursor";
}

export function claudeHookResponse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

export function geminiHookResponse(reason: string): string {
  return JSON.stringify({
    decision: "deny",
    reason,
  });
}

export function cursorHookResponse(reason: string): string {
  return JSON.stringify({
    permission: "deny",
    agent_message: reason,
    user_message: "Miru: use MCP search/expand instead of built-in grep/glob.",
  });
}

export async function runSearchGuardFromStdin(): Promise<number> {
  const text = await Bun.stdin.text();
  if (!text.trim()) {
    return 0;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 0;
  }

  const payload = normalizeHookPayload(raw);
  const decision = evaluateSearchGuard(payload);
  if (!decision.block) {
    return 0;
  }

  const format = hookResponseFormat(payload);
  if (format === "claude") {
    process.stdout.write(claudeHookResponse(decision.reason));
    return 0;
  }
  if (format === "gemini") {
    process.stdout.write(geminiHookResponse(decision.reason));
    return 0;
  }
  if (format === "stderr") {
    process.stderr.write(decision.reason);
    return 2;
  }

  process.stdout.write(cursorHookResponse(decision.reason));
  return 2;
}
