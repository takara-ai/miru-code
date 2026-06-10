/**
 * OpenCode plugin: blocks built-in search tools in favor of Miru MCP.
 * Installed to ~/.config/opencode/plugins/miru-search-guard.ts
 */

const REDIRECT = "Use Miru MCP search (repo = project root) instead of grep/glob/bash exploration.";

const GREP_TOOLS = new Set(["grep", "glob", "codesearch", "codebase_search", "search"]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh"]);

function isLiteral(pattern: string): boolean {
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
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed) && trimmed.length <= 48) {
    return true;
  }
  return false;
}

function isExplorationShell(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) {
    return false;
  }
  if (
    /\b(git|npm|bun|pnpm|yarn|cargo|go|make|cmake|docker|kubectl|pytest|jest|vitest)\b/.test(cmd)
  ) {
    return false;
  }
  return /\b(rg|ripgrep|grep|find|ag|ack|fd)\b/.test(cmd);
}

function shouldBlock(tool: string, args: Record<string, unknown>): boolean {
  const name = tool.toLowerCase();
  if (name.includes("miru")) {
    return false;
  }
  if (GREP_TOOLS.has(name)) {
    const pattern = String(args.pattern ?? args.query ?? args.regex ?? args.needle ?? "");
    return !isLiteral(pattern);
  }
  if (SHELL_TOOLS.has(name)) {
    const command = String(args.command ?? args.cmd ?? "");
    return isExplorationShell(command);
  }
  return false;
}

export default async function MiruSearchGuardPlugin() {
  return {
    "tool.execute.before": async (
      input: { tool: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (shouldBlock(input.tool, output.args ?? {})) {
        throw new Error(REDIRECT);
      }
    },
  };
}
