import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AgentId = "claude" | "copilot" | "cursor" | "gemini" | "kiro" | "opencode";

const AGENTS_DIR = join(import.meta.dir, "agents");

export function agentDestination(agent: AgentId): string {
  const baseDir = agent === "copilot" ? ".github" : `.${agent}`;
  return join(baseDir, "agents", "miru-code.md");
}

export async function loadAgentTemplate(agent: AgentId): Promise<string> {
  return readFile(join(AGENTS_DIR, `${agent}.md`), "utf-8");
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
  await mkdir(dirname(dest), { recursive: true });
  const content = await loadAgentTemplate(agent);
  await Bun.write(dest, content);
  return dest;
}
