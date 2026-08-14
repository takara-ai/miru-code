import {
  ensureSharedSkillOwnersOnInstall,
  isSharedSkillPath,
  removeSkillMdAndOwners,
  resolveSharedSkillUninstall,
  SKILL_OWNERS_FILE,
  type SharedSkillCtx,
  type SharedSkillUninstallDecision,
  type SkillPathOf,
} from "./shared-skill.ts";
import type { AgentTarget, InstallAction } from "./agents.ts";

/** @deprecated Prefer SKILL_OWNERS_FILE — same sidecar name for all shared skills. */
export const CAVEMAN_OWNERS_FILE = SKILL_OWNERS_FILE;

/** Context for shared `~/.agents/skills` Caveman install/uninstall. */
export type CavemanSharedCtx = SharedSkillCtx;

export type SharedCavemanUninstallDecision = SharedSkillUninstallDecision;

const cavemanPathOf: SkillPathOf = (agent) => agent.cavemanSkillPath;

export function isSharedCavemanPath(path: string, allAgents: AgentTarget[]): boolean {
  return isSharedSkillPath(path, allAgents, cavemanPathOf);
}

export async function ensureSharedCavemanOwnersOnInstall(
  skillDir: string,
  skillPath: string,
  agent: AgentTarget,
  ctx: CavemanSharedCtx,
): Promise<void> {
  return ensureSharedSkillOwnersOnInstall(skillDir, skillPath, agent, ctx, cavemanPathOf);
}

export async function resolveSharedCavemanUninstall(
  path: string,
  skillDir: string,
  agent: AgentTarget,
  ctx: CavemanSharedCtx,
): Promise<SharedCavemanUninstallDecision> {
  return resolveSharedSkillUninstall(path, skillDir, agent, ctx, cavemanPathOf);
}

/** Remove SKILL.md and owners sidecar; leave sibling skill folders untouched. */
export async function removeCavemanSkillFiles(
  path: string,
  skillDir: string,
): Promise<Extract<InstallAction, "removed" | "not-found">> {
  return removeSkillMdAndOwners(path, skillDir);
}
