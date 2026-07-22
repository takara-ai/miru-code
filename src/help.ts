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
  section("Self-hosted (AWS SageMaker)");
  writeStdout("  MIRU_SAGEMAKER_ENDPOINT_ARN");
  writeStdout("      arn:aws:sagemaker:<region>:<account-id>:endpoint/<name> — set this to");
  writeStdout("      bypass Takara entirely and embed via your own SageMaker endpoint.");
  writeStdout("  MIRU_SAGEMAKER_ENDPOINT_NAME / MIRU_SAGEMAKER_REGION");
  writeStdout("      Alternative to the ARN when you'd rather name the endpoint + region");
  writeStdout("      directly (falls back to AWS_REGION / AWS_DEFAULT_REGION).");
  writeStdout("  MIRU_SAGEMAKER_NORMALIZE / MIRU_SAGEMAKER_TRUNCATE");
  writeStdout("      Default: true");
  writeStdout("  MIRU_SAGEMAKER_TRUNCATION_DIRECTION");
  writeStdout('      "Left" | "Right" (default: Right)');
  writeStdout("  MIRU_SAGEMAKER_PROMPT_NAME");
  writeStdout("      Optional prompt_name passed to the endpoint");
  writeStdout("  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_PROFILE");
  writeStdout("      Standard AWS credential resolution — nothing Miru-specific to set");
  writeStdout("");
  hint("Enterprise self-hosted setup: docs/self-hosted-sagemaker.md");
  hint("Admin runbook: bun run sagemaker:create-invoke-user -- --endpoint-arn <arn>");
  hint("Then: miru setup --sagemaker --arn <arn> --profile <name>");
  hint("Setup confirms auth, saves SageMaker config, and removes any stored Takara API key.");
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
      writeStdout("  --match-variants    Also match camelCase/snake_case/kebab-case/CONSTANT_CASE");
      writeStdout("  --include GLOB      Only search files matching this glob (repeatable)");
      writeStdout("  --exclude GLOB      Skip files matching this glob (repeatable)");
      writeStdout("  --context N         Lines of context around each match (mode=lines)");
      writeStdout("  --content TYPE      code | docs | config | all (default: code config)");
      writeStdout("  --json              JSON output (default when piped)");
      section("Example");
      writeStdout("  miru locate MIRU_BENCHMARK_HISTORY_PATH . --mode locations");
      writeStdout(
        '  miru locate rateLimit . --match-variants --include "apps/tldr/**" --context 3',
      );
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
      commandHeader("setup", "Store and validate Takara or self-hosted SageMaker credentials.");
      section("Usage");
      writeStdout("  miru setup [--key TOKEN] [--force] [--clear]");
      writeStdout("  miru setup --sagemaker --arn ENDPOINT_ARN --profile NAME");
      section("Options (Takara)");
      writeStdout("  --key, -k TOKEN     Non-interactive key entry");
      writeStdout("  --force             Replace an existing stored key");
      writeStdout("  --clear             Remove stored credentials");
      section("Options (SageMaker)");
      writeStdout("  --sagemaker         Switch setup to self-hosted SageMaker mode");
      writeStdout("  --arn ARN           Endpoint ARN (implies --sagemaker)");
      writeStdout("  --profile NAME       AWS profile to inherit credentials from");
      writeStdout("");
      hint("Enterprise guide: docs/self-hosted-sagemaker.md (Marketplace + invoke-user runbook).");
      hint("Takara and SageMaker are mutually exclusive — setup for one removes the other.");
      hint("SageMaker setup invokes the endpoint once (auth + embedding check), then saves.");
      hint("Miru only inherits AWS credentials — it never creates IAM users or writes ~/.aws.");
      hint("Admin runbook (repo): bun run sagemaker:create-invoke-user -- --endpoint-arn <arn>");
      hint("Then: miru setup --sagemaker --arn <arn> --profile miru");
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
      writeStdout("Override path with MIRU_BENCHMARK_HISTORY_PATH. Append-only JSONL of savings.");
      writeStdout("Repo paths in the report are plaintext — use `clear` on shared machines.");
      writeStdout("");
      writeStdout("Savings compare Miru MCP response tokens (search text + expand text)");
      writeStdout("to a Grep baseline (rg search + read of the top matched file),");
      writeStdout("not bare chunk content and not the agent's full tool chain.");
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
