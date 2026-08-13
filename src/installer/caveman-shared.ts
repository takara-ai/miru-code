import { mkdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_TARGETS,
  type AgentTarget,
  type InstallAction,
  isAgentDetected,
} from "./agents.ts";

export const CAVEMAN_OWNERS_FILE = "miru-owners.json";

/** Context for shared Copilot-family Caveman install/uninstall. */
export interface CavemanSharedCtx {
  selectedAgents: AgentTarget[];
  allAgents?: AgentTarget[];
  isDetected?: (agent: AgentTarget) => Promise<boolean>;
}

export function isSharedCavemanPath(path: string, allAgents: AgentTarget[]): boolean {
  return allAgents.filter((agent) => agent.cavemanSkillPath === path).length > 1;
}

export async function readCavemanOwners(skillDir: string): Promise<string[] | null> {
  const ownersPath = join(skillDir, CAVEMAN_OWNERS_FILE);
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

export async function writeCavemanOwners(skillDir: string, owners: string[]): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await Bun.write(
    join(skillDir, CAVEMAN_OWNERS_FILE),
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
export async function ensureSharedCavemanOwnersOnInstall(
  skillDir: string,
  skillPath: string,
  agent: AgentTarget,
  ctx: CavemanSharedCtx,
): Promise<void> {
  const existing = await readCavemanOwners(skillDir);
  if (existing !== null) {
    await writeCavemanOwners(skillDir, Array.from(new Set([...existing, agent.id])));
    return;
  }

  if (!(await Bun.file(skillPath).exists())) {
    await writeCavemanOwners(skillDir, [agent.id]);
    return;
  }

  const all = ctx.allAgents ?? AGENT_TARGETS;
  const detect = ctx.isDetected ?? isAgentDetected;
  const family = all.filter((member) => member.cavemanSkillPath === skillPath);
  const seeded: string[] = [];
  for (const member of family) {
    if (member.id === agent.id || (await detect(member))) {
      seeded.push(member.id);
    }
  }
  const unique = Array.from(new Set(seeded));
  if (unique.length <= 1) {
    return;
  }
  await writeCavemanOwners(skillDir, unique);
}

async function shouldKeepSharedCaveman(
  path: string,
  agent: AgentTarget,
  ctx: CavemanSharedCtx,
): Promise<boolean> {
  const all = ctx.allAgents ?? AGENT_TARGETS;
  const detect = ctx.isDetected ?? isAgentDetected;
  const siblings = all.filter(
    (other) => other.id !== agent.id && other.cavemanSkillPath === path,
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

export type SharedCavemanUninstallDecision =
  | { kind: "defer"; note: string }
  | { kind: "keep"; note: string }
  | { kind: "remove" };

/**
 * Decide whether a shared-path Caveman uninstall should defer, keep, or remove.
 * Caller removes files only on `remove`.
 */
export async function resolveSharedCavemanUninstall(
  path: string,
  skillDir: string,
  agent: AgentTarget,
  ctx: CavemanSharedCtx,
): Promise<SharedCavemanUninstallDecision> {
  const selectedSharing = ctx.selectedAgents.filter(
    (selected) => selected.cavemanSkillPath === path,
  );
  const isLast =
    selectedSharing.length === 0 ||
    selectedSharing[selectedSharing.length - 1]?.id === agent.id;
  if (!isLast) {
    return {
      kind: "defer",
      note: "shared skill; remove deferred to last selected IDE",
    };
  }

  const owners = await readCavemanOwners(skillDir);
  if (owners) {
    const removing = new Set(selectedSharing.map((selected) => selected.id));
    const remaining = owners.filter((ownerId) => !removing.has(ownerId));
    if (remaining.length > 0) {
      await writeCavemanOwners(skillDir, remaining);
      return {
        kind: "keep",
        note: "shared skill kept — still owned by another IDE",
      };
    }
    return { kind: "remove" };
  }

  if (await shouldKeepSharedCaveman(path, agent, ctx)) {
    return {
      kind: "keep",
      note: "shared skill kept — another Copilot-family IDE is still detected",
    };
  }
  return { kind: "remove" };
}

/** Remove SKILL.md and owners sidecar; cleans orphans if only one remains. */
export async function removeCavemanSkillFiles(
  path: string,
  skillDir: string,
): Promise<Extract<InstallAction, "removed" | "not-found">> {
  let removedSomething = false;

  if (await Bun.file(path).exists()) {
    await unlink(path);
    removedSomething = true;
  }

  const ownersPath = join(skillDir, CAVEMAN_OWNERS_FILE);
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
