import { mkdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_TARGETS,
  type AgentTarget,
  type InstallAction,
  isAgentDetected,
} from "./agents.ts";

/** Sidecar next to a shared Agent Skill (`SKILL.md`) tracking which IDEs own it. */
export const SKILL_OWNERS_FILE = "miru-owners.json";

/** Context for shared-path skill install/uninstall (Caveman, STE, …). */
export interface SharedSkillCtx {
  selectedAgents: AgentTarget[];
  allAgents?: AgentTarget[];
  isDetected?: (agent: AgentTarget) => Promise<boolean>;
}

export type SkillPathOf = (agent: AgentTarget) => string | null;

function uniqueIds(ids: Iterable<string>): string[] {
  return Array.from(new Set(ids));
}

function resolvedAgents(ctx: SharedSkillCtx): AgentTarget[] {
  return ctx.allAgents ?? AGENT_TARGETS;
}

function agentsSharingPath(
  path: string,
  allAgents: AgentTarget[],
  pathOf: SkillPathOf,
): AgentTarget[] {
  return allAgents.filter((agent) => pathOf(agent) === path);
}

export function isSharedSkillPath(
  path: string,
  allAgents: AgentTarget[],
  pathOf: SkillPathOf,
): boolean {
  return agentsSharingPath(path, allAgents, pathOf).length > 1;
}

export async function readSkillOwners(skillDir: string): Promise<string[] | null> {
  const ownersPath = join(skillDir, SKILL_OWNERS_FILE);
  if (!(await Bun.file(ownersPath).exists())) {
    return null;
  }
  try {
    const parsed = JSON.parse(await Bun.file(ownersPath).text()) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

export async function writeSkillOwners(skillDir: string, owners: string[]): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await Bun.write(
    join(skillDir, SKILL_OWNERS_FILE),
    `${JSON.stringify([...owners].sort(), null, 2)}\n`,
  );
}

/**
 * Stamp shared-path ownership on install.
 * - Existing owners file: add current agent.
 * - Fresh skill: start with current agent only.
 * - Legacy skill (file exists, no owners): seed from detected siblings + current;
 *   skip writing a singleton so uninstall stays on the legacy keep path.
 */
export async function ensureSharedSkillOwnersOnInstall(
  skillDir: string,
  skillPath: string,
  agent: AgentTarget,
  ctx: SharedSkillCtx,
  pathOf: SkillPathOf,
): Promise<void> {
  const existing = await readSkillOwners(skillDir);
  if (existing !== null) {
    await writeSkillOwners(skillDir, uniqueIds([...existing, agent.id]));
    return;
  }

  if (!(await Bun.file(skillPath).exists())) {
    await writeSkillOwners(skillDir, [agent.id]);
    return;
  }

  const detect = ctx.isDetected ?? isAgentDetected;
  const seeded: string[] = [];
  for (const member of agentsSharingPath(skillPath, resolvedAgents(ctx), pathOf)) {
    if (member.id === agent.id || (await detect(member))) {
      seeded.push(member.id);
    }
  }
  const unique = uniqueIds(seeded);
  if (unique.length <= 1) {
    return;
  }
  await writeSkillOwners(skillDir, unique);
}

async function shouldKeepSharedSkill(
  path: string,
  agent: AgentTarget,
  ctx: SharedSkillCtx,
  pathOf: SkillPathOf,
): Promise<boolean> {
  const detect = ctx.isDetected ?? isAgentDetected;
  const siblings = agentsSharingPath(path, resolvedAgents(ctx), pathOf).filter(
    (other) => other.id !== agent.id,
  );

  for (const sibling of siblings) {
    if (ctx.selectedAgents.some((selected) => selected.id === sibling.id)) {
      continue;
    }
    if (await detect(sibling)) {
      return true;
    }
  }
  return false;
}

export type SharedSkillUninstallDecision =
  | { kind: "defer"; note: string }
  | { kind: "keep"; note: string }
  | { kind: "remove" };

/**
 * Decide whether a shared-path skill uninstall should defer, keep, or remove.
 * Caller removes files only on `remove`.
 */
export async function resolveSharedSkillUninstall(
  path: string,
  skillDir: string,
  agent: AgentTarget,
  ctx: SharedSkillCtx,
  pathOf: SkillPathOf,
): Promise<SharedSkillUninstallDecision> {
  const selectedSharing = agentsSharingPath(path, ctx.selectedAgents, pathOf);
  const isLast =
    selectedSharing.length === 0 ||
    selectedSharing[selectedSharing.length - 1]?.id === agent.id;
  if (!isLast) {
    return {
      kind: "defer",
      note: "shared skill; remove deferred to last selected IDE",
    };
  }

  const owners = await readSkillOwners(skillDir);
  if (owners !== null) {
    const removing = new Set<string>(selectedSharing.map((selected) => selected.id));
    const remaining = owners.filter((ownerId) => !removing.has(ownerId));
    if (remaining.length > 0) {
      await writeSkillOwners(skillDir, remaining);
      return {
        kind: "keep",
        note: "shared skill kept — still owned by another IDE",
      };
    }
    return { kind: "remove" };
  }

  if (await shouldKeepSharedSkill(path, agent, ctx, pathOf)) {
    return {
      kind: "keep",
      note: "shared skill kept — another IDE still uses this path",
    };
  }
  return { kind: "remove" };
}

/** Remove SKILL.md and owners sidecar; leave sibling skill folders untouched. */
export async function removeSkillMdAndOwners(
  path: string,
  skillDir: string,
): Promise<Extract<InstallAction, "removed" | "not-found">> {
  let removedSomething = false;

  if (await Bun.file(path).exists()) {
    await unlink(path);
    removedSomething = true;
  }

  const ownersPath = join(skillDir, SKILL_OWNERS_FILE);
  if (await Bun.file(ownersPath).exists()) {
    await unlink(ownersPath);
    removedSomething = true;
  }

  try {
    await rmdir(skillDir);
  } catch {
    // Directory not empty or already gone — leave other skills alone.
  }

  return removedSomething ? "removed" : "not-found";
}
