import type { AgentId } from "./agents.ts";

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
  const lines = [
    "",
    "Miru (見る) — hybrid code search for agents",
    "",
    "Usage:",
    "  miru                         Start MCP server (stdio)",
    "  miru <command> [options]",
    "",
    "Commands:",
    "  search        Hybrid search over a codebase",
    "  find-related  Find chunks related to a file:line",
    "  setup         Save your Takara API key locally",
    "  init          Write a miru-code sub-agent for your IDE",
    "  clear         Remove cached index for a path",
    "",
    "Quick start:",
    "  miru setup",
    "  miru init --agent cursor",
    '  miru search "auth middleware" ./src',
    "",
    "Run miru help <command> for details.",
    "Run miru -h for environment variables.",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printEnvHelp(): void {
  const lines = [
    "",
    "Environment:",
    "  TAKARA_API_KEY",
    "      Takara bearer token for embeddings",
    "  MIRU_OPENAI_BASE_URL",
    "      Default: infer.dev.takara.ai",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printFullHelp(): void {
  printMainHelp();
  printEnvHelp();
}

export function printCommandHelp(command: string): void {
  switch (command) {
    case "search":
      process.stdout.write(
        [
          "",
          "miru search — hybrid search",
          "",
          "Usage:",
          "  miru search <query> [path] [-k N] [--content TYPE ...]",
          "",
          "Options:",
          "  -k, --top-k N       Number of results (default: 5)",
          "  --content TYPE      code | docs | config | all (default: code)",
          "",
          "Example:",
          '  miru search "where is auth" ./src -k 10 --content code docs',
          "",
        ].join("\n"),
      );
      return;
    case "find-related":
      process.stdout.write(
        [
          "",
          "miru find-related — related chunks",
          "",
          "Usage:",
          "  miru find-related <file> <line> [path] [-k N] [--content TYPE ...]",
          "",
          "Example:",
          "  miru find-related src/auth.ts 42 . -k 8",
          "",
        ].join("\n"),
      );
      return;
    case "setup":
      process.stdout.write(
        [
          "",
          "miru setup — store API key",
          "",
          "Usage:",
          "  miru setup",
          "  miru setup --key TOKEN",
          "  miru setup --force",
          "  miru setup --clear",
          "",
          "Options:",
          "  --key, -k TOKEN     Provide key on the command line (non-interactive)",
          "  --force             Replace an existing stored key",
          "  --clear             Remove stored credentials",
          "",
        ].join("\n"),
      );
      return;
    case "init":
      process.stdout.write(
        [
          "",
          "miru init — IDE sub-agent file",
          "",
          "Usage:",
          "  miru init --agent AGENT [--force]",
          "",
          "Agents:",
          `  ${AGENT_LIST}`,
          "",
          "Examples:",
          "  miru init --agent cursor",
          "  miru init --agent claude --force",
          "",
        ].join("\n"),
      );
      return;
    case "clear":
      process.stdout.write(
        [
          "",
          "miru clear — drop cached index",
          "",
          "Usage:",
          "  miru clear [path]",
          "",
          "Example:",
          "  miru clear .",
          "",
        ].join("\n"),
      );
      return;
    case "mcp":
      process.stdout.write(
        [
          "",
          "miru — MCP server (default with no subcommand)",
          "",
          "Usage:",
          "  miru [--ref BRANCH] [--content TYPE ...]",
          "",
          "Indexes a repo on the first search/find_related tool call (repo argument).",
          "With no path, uses the process working directory.",
          "",
        ].join("\n"),
      );
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printMainHelp();
      process.exit(1);
  }
  process.stdout.write("\n");
}

export function formatUnknownAgent(agent: string): string {
  return `Unknown agent "${agent}". Choose one of: ${AGENT_LIST}`;
}
