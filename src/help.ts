import type { AgentId } from "./agents.ts";
import {
  brandTitle,
  commandRow,
  divider,
  fail,
  header,
  hint,
  section,
  writeStdout,
} from "./cli-ui.ts";

export const AGENT_IDS: readonly AgentId[] = [
  "claude",
  "copilot",
  "cursor",
  "gemini",
  "kiro",
  "opencode",
] as const;

const AGENT_LIST = AGENT_IDS.join(", ");

export function printMainHelp(): void {
  header("hybrid code search for agents");

  section("Usage");
  writeStdout("  miru                         Start MCP server (stdio)");
  writeStdout("  miru <command> [options]");
  divider();

  section("Commands");
  commandRow("search", "Hybrid search over a codebase");
  commandRow("expand", "Adjacent chunks in the same file as a hit");
  commandRow("find-related", "Find chunks related to a file:line");
  commandRow("setup", "Save your Takara API key locally");
  commandRow("install", "Configure miru across coding agents");
  commandRow("uninstall", "Remove miru agent configuration");
  commandRow("init", "Write a project-local sub-agent file");
  commandRow("clear", "Remove cached index for a path");
  commandRow("help", "Show help for a command");
  divider();

  section("Quick start");
  writeStdout("  miru setup && miru install");
  writeStdout('  miru search "auth middleware" ./src');
  writeStdout("");
  hint("miru help <command>  ·  miru -h for environment variables  ·  miru -v for version");
  writeStdout("");
}

export function printEnvHelp(): void {
  section("Environment");
  writeStdout("  TAKARA_API_KEY");
  writeStdout("      Takara bearer token for embeddings");
  writeStdout("  MIRU_OPENAI_BASE_URL");
  writeStdout("      Default: https://infer.takara.ai/v1");
  writeStdout("  MIRU_CONCURRENCY");
  writeStdout("      Parallel workers (default: CPUs − 2)");
  writeStdout("");
}

export function printFullHelp(): void {
  printMainHelp();
  printEnvHelp();
}

function printCommandHeader(name: string, summary: string): void {
  writeStdout("");
  writeStdout(`${brandTitle()} ${name}`);
  writeStdout(summary);
  divider();
}

export function printCommandHelp(command: string): void {
  switch (command) {
    case "search":
      printCommandHeader("search", "Hybrid semantic + keyword search.");
      section("Usage");
      writeStdout("  miru search <query> [path] [options]");
      section("Options");
      writeStdout("  -k, --top-k N       Number of results (default: 5)");
      writeStdout("  --content TYPE      code | docs | config | all");
      writeStdout("  --json              JSON output (default when piped)");
      section("Example");
      writeStdout('  miru search "where is auth" ./src -k 10 --content code docs');
      writeStdout("");
      return;
    case "expand":
      printCommandHeader("expand", "More context in the same file as a search hit.");
      section("Usage");
      writeStdout("  miru expand <file> <line> [path] [--before N] [--after N]");
      section("Example");
      writeStdout("  miru expand src/auth.ts 42 . --before 2 --after 2");
      writeStdout("");
      return;
    case "find-related":
      printCommandHeader("find-related", "Semantic neighbors of a file location.");
      section("Usage");
      writeStdout("  miru find-related <file> <line> [path] [options]");
      section("Example");
      writeStdout("  miru find-related src/auth.ts 42 . -k 8");
      writeStdout("");
      return;
    case "setup":
      printCommandHeader("setup", "Store and validate your Takara API key.");
      section("Usage");
      writeStdout("  miru setup [--key TOKEN] [--force] [--clear]");
      section("Options");
      writeStdout("  --key, -k TOKEN     Non-interactive key entry");
      writeStdout("  --force             Replace an existing stored key");
      writeStdout("  --clear             Remove stored credentials");
      writeStdout("");
      return;
    case "install":
      printCommandHeader("install", "Interactive global agent setup.");
      writeStdout("Configures MCP server, instructions, and sub-agent files under");
      writeStdout("your user config (~/.claude, ~/.cursor, etc.).");
      writeStdout("");
      writeStdout("Run miru setup first, or set TAKARA_API_KEY for MCP env expansion.");
      writeStdout("");
      return;
    case "uninstall":
      printCommandHeader("uninstall", "Remove miru configuration from agents.");
      writeStdout("Removes MCP entries, marked instruction blocks, and global sub-agents.");
      writeStdout("");
      return;
    case "init":
      printCommandHeader("init", "Project-local sub-agent file.");
      writeStdout("Prefer miru install for global setup. Use init to commit into a repo.");
      section("Usage");
      writeStdout("  miru init --agent AGENT [--force]");
      section("Agents");
      writeStdout(`  ${AGENT_LIST}`);
      section("Example");
      writeStdout("  miru init --agent claude --force");
      writeStdout("");
      return;
    case "clear":
      printCommandHeader("clear", "Drop the on-disk index cache.");
      section("Usage");
      writeStdout("  miru clear [path]");
      section("Example");
      writeStdout("  miru clear .");
      writeStdout("");
      return;
    case "mcp":
      printCommandHeader("mcp", "Stdio MCP server (default with no subcommand).");
      section("Usage");
      writeStdout("  miru [--ref BRANCH] [--content TYPE ...]");
      writeStdout("");
      writeStdout("Indexes on the first search/expand/find_related tool call (repo argument).");
      writeStdout("");
      return;
    default:
      failHelp(command);
  }
}

function failHelp(command: string): never {
  fail(`Unknown command: ${command}`);
  writeStdout("");
  printMainHelp();
  process.exit(1);
}

export function formatUnknownAgent(agent: string): string {
  return `Unknown agent "${agent}". Choose one of: ${AGENT_LIST}`;
}
