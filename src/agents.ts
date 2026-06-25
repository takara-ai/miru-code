import { join } from "node:path";
import { buildSubagentBody, type NativeToolNames } from "./installer/search-policy.ts";

export type AgentId = "claude" | "copilot" | "cursor" | "gemini" | "kiro" | "opencode";

const AGENTS_DIR = join(import.meta.dir, "agents");

const AGENT_NATIVE_TOOLS: Record<AgentId, NativeToolNames> = {
  claude: {
    explorationDenied: "Grep, Glob, SemanticSearch, or Read",
    grep: "Grep",
    read: "Read",
  },
  cursor: {
    explorationDenied: "Grep, Glob, SemanticSearch, or Read",
    grep: "Grep",
    read: "Read",
  },
  copilot: {
    explorationDenied: "grep_search, codebase_search, glob, or read_file",
    grep: "grep_search",
    read: "read_file",
  },
  gemini: {
    explorationDenied: "grep_search, glob, or read_file",
    grep: "grep_search",
    read: "read_file",
  },
  kiro: {
    explorationDenied: "built-in grep, file search, or broad file reads",
    grep: "Grep",
    read: "Read",
  },
  opencode: {
    explorationDenied: "grep, glob, or read-for-exploration",
    grep: "grep",
    read: "read",
  },
};

export function agentDestination(agent: AgentId): string {
  const baseDir = agent === "copilot" ? ".github" : `.${agent}`;
  return join(baseDir, "agents", "miru-code.md");
}

export async function loadAgentTemplate(agent: AgentId): Promise<string> {
  const frontmatter = (await Bun.file(join(AGENTS_DIR, `${agent}.md`)).text()).trim();
  const body = buildSubagentBody(AGENT_NATIVE_TOOLS[agent]);
  return `${frontmatter}\n\n${body}\n`;
}

export async function writeAgentFile(
  agent: AgentId,
  options: { force?: boolean } = {},
): Promise<string> {
  const dest = agentDestination(agent);
  const existing = await Bun.file(dest).exists();
  if (existing && !options.force) {
    throw new Error(`${dest} already exists. Run with --force to overwrite.`);
  }
  const content = await loadAgentTemplate(agent);
  await Bun.write(dest, content);
  return dest;
}
