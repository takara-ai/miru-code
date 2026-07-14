import type { AgentId } from "./agents.ts";
import {
  commandHeader,
  commandRow,
  divider,
  fail,
  header,
  hint,
  section,
  writeStdout,
} from "./cli-ui.ts";
import { DEFAULT_RESERVE_CORES } from "./concurrency.ts";
import { DEFAULT_EMBEDDING_BASE_URL, DEFAULT_EMBEDDING_MODEL } from "./embeddings/openai.ts";
import { TAKARA_API_KEY_ENV } from "./env.ts";

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
  header();

  section("Usage");
  writeStdout("  miru                         Start MCP server (stdio)");
  writeStdout("  miru <command> [options]");
  divider();

  section("Commands");
  commandRow("search", "Hybrid search over a codebase");
  commandRow("locate", "Exact substring location in the index");
  commandRow("expand", "Adjacent chunks in the same file as a hit");
  commandRow("find-related", "Find chunks related to a file:line");
  commandRow("setup", "Save your Takara API key locally");
  commandRow("install", "Configure miru across coding agents");
  commandRow("uninstall", "Remove miru agent configuration");
  commandRow("benchmark", "Turn MCP benchmark mode on or off");
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
  writeStdout(`  ${TAKARA_API_KEY_ENV}`);
  writeStdout("      Takara bearer token for embeddings");
  writeStdout("  MIRU_OPENAI_BASE_URL");
  writeStdout(`      Default: ${DEFAULT_EMBEDDING_BASE_URL}`);
  writeStdout("  MIRU_OPENAI_EMBEDDING_MODEL");
  writeStdout(`      Default: ${DEFAULT_EMBEDDING_MODEL}`);
  writeStdout("  MIRU_CONCURRENCY");
  writeStdout(`      Parallel workers (default: CPUs − ${DEFAULT_RESERVE_CORES})`);
  writeStdout("  MIRU_TOKENIZER_JSON");
  writeStdout("      Path to tokenizer.json (default: <package>/tokenizer/tokenizer.json)");
  writeStdout("");
}

export function printFullHelp(): void {
  printMainHelp();
  printEnvHelp();
}

export function printCommandHelp(command: string): void {
  switch (command) {
    case "search":
      commandHeader("search", "Hybrid semantic + keyword search.");
      section("Usage");
      writeStdout("  miru search <query> [path] [options]");
      section("Options");
      writeStdout("  -k, --top-k N       Number of results (default: 5)");
      writeStdout("  --content TYPE      code | docs | config | all (default: code config)");
      writeStdout("  --json              JSON output (default when piped)");
      section("Example");
      writeStdout('  miru search "where is auth" ./src -k 10 --content code docs');
      writeStdout("");
      return;
    case "locate":
      commandHeader("locate", "Exact substring location over the Miru index.");
      section("Usage");
      writeStdout("  miru locate <literal> [path] [options]");
      section("Options");
      writeStdout("  --mode MODE         count | locations | lines (default: lines)");
      writeStdout("  --limit N           Optional hit cap (default: all matches)");
      writeStdout("  --ignore-case       Case-insensitive match");
      writeStdout("  --content TYPE      code | docs | config | all (default: code config)");
      writeStdout("  --json              JSON output (default when piped)");
      section("Example");
      writeStdout("  miru locate MIRU_BENCHMARK_HISTORY_PATH . --mode locations");
      writeStdout("");
      return;
    case "expand":
      commandHeader("expand", "More context in the same file as a search hit.");
      section("Usage");
      writeStdout("  miru expand <file> <line> [path] [--before N] [--after N]");
      section("Example");
      writeStdout("  miru expand src/auth.ts 42 . --before 2 --after 2");
      writeStdout("");
      return;
    case "find-related":
      commandHeader("find-related", "Semantic neighbors of a file location.");
      section("Usage");
      writeStdout("  miru find-related <file> <line> [path] [options]");
      section("Example");
      writeStdout("  miru find-related src/auth.ts 42 . -k 8");
      writeStdout("");
      return;
    case "setup":
      commandHeader("setup", "Store and validate your Takara API key.");
      section("Usage");
      writeStdout("  miru setup [--key TOKEN] [--force] [--clear]");
      section("Options");
      writeStdout("  --key, -k TOKEN     Non-interactive key entry");
      writeStdout("  --force             Replace an existing stored key");
      writeStdout("  --clear             Remove stored credentials");
      writeStdout("");
      return;
    case "install":
      commandHeader("install", "Interactive global agent setup.");
      writeStdout("Configures MCP server, instructions, and sub-agent files under");
      writeStdout("your user config (~/.claude, ~/.cursor, etc.).");
      writeStdout("");
      writeStdout("Run miru setup first, or set TAKARA_API_KEY for MCP env expansion.");
      writeStdout("");
      return;
    case "uninstall":
      commandHeader("uninstall", "Remove miru configuration from agents.");
      writeStdout("Removes MCP entries, marked instruction blocks, and global sub-agents.");
      writeStdout("Also deletes the global benchmark report from Miru's state directory.");
      writeStdout("");
      return;
    case "benchmark":
      commandHeader("benchmark", "Toggle MCP benchmark mode on installed agents.");
      section("Usage");
      writeStdout("  miru benchmark on");
      writeStdout("  miru benchmark off");
      writeStdout("  miru benchmark status");
      writeStdout("  miru benchmark clear");
      writeStdout("");
      writeStdout("Adds or removes `--benchmark` from Miru MCP args in agent configs.");
      writeStdout("If `--benchmark` is present, benchmark mode is on — no env overrides.");
      writeStdout("Restart agents after changing mode. Prefer `off` when finished measuring.");
      writeStdout("");
      writeStdout("History is a global report (not per-repo) under Miru's state directory.");
      writeStdout("Override path with MIRU_BENCHMARK_HISTORY_PATH. Keeps the last 500 queries.");
      writeStdout("Queries and repo paths are stored in plaintext — use `clear` on shared machines.");
      writeStdout("");
      writeStdout("Savings compare Miru workflow tokens to a Grep baseline");
      writeStdout("(rg search + read of the top matched file), not the agent's full tool chain.");
      writeStdout("Local paths only — git URL repos skip comparison with benchmark_skipped.");
      writeStdout("");
      return;
    case "init":
      commandHeader("init", "Project-local sub-agent file.");
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
      commandHeader("clear", "Drop the on-disk index cache.");
      section("Usage");
      writeStdout("  miru clear [path]");
      section("Example");
      writeStdout("  miru clear .");
      writeStdout("");
      return;
    case "mcp":
      commandHeader("mcp", "Stdio MCP server (default with no subcommand).");
      section("Usage");
      writeStdout("  miru [--ref BRANCH] [--content TYPE ...] [--benchmark]");
      writeStdout("  Default content: code config");
      writeStdout("");
      writeStdout("Indexes on the first search/expand/find_related tool call (repo argument).");
      writeStdout("Use --benchmark (or `miru benchmark on`) for token-savings comparisons.");
      writeStdout("Leave with `miru benchmark off` and restart the agent.");
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
