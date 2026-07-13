/**
 * OpenCode plugin: blocks built-in search tools in favor of Miru MCP.
 * Installed to ~/.config/opencode/plugins/miru-search-guard.ts
 */

const REDIRECT =
  "Use Miru MCP (repo = project root): `locate` for exact literals, `search` for meaning-based questions — not grep/glob/bash exploration.";

const GREP_TOOLS = new Set(["grep", "glob", "codesearch", "codebase_search", "search"]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh"]);

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
  if (name === "glob") {
    return true;
  }
  if (GREP_TOOLS.has(name)) {
    return true;
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
