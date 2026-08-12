import { mkdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadAgentTemplate } from "../agents.ts";
import { clearBenchmarkHistory } from "../benchmark/history.ts";
import { brandTitle, dim, divider, green, hint, info, success, writeStdout } from "../cli-ui.ts";
import { ensureCredentials } from "../setup.ts";
import {
  AGENT_TARGETS,
  type AgentTarget,
  INSTRUCTIONS,
  type InstallAction,
  type InstallMode,
  isAgentDetected,
} from "./agents.ts";
import { withPreservedBenchmarkFlag } from "./benchmark-mode.ts";
import {
  ensureSharedCavemanOwnersOnInstall,
  isSharedCavemanPath,
  removeCavemanSkillFiles,
  resolveSharedCavemanUninstall,
} from "./caveman-shared.ts";
import {
  codexSkillsFeatureEnabled,
  ensureCodexSkillsFeature,
  mergeJsonMember,
  mergeTomlBlock,
  removeJsonMember,
  removeMarked,
  removeTomlBlock,
  replaceOrAppendMarked,
  stripJsonComments,
} from "./config.ts";
import { mergeHooks, removeHooks } from "./hooks/install.ts";
import { promptConfirm, promptMultiSelect, requireInteractiveTerminal } from "./prompt.ts";
import { CURSOR_RULES_MDC } from "./search-policy.ts";
import { CAVEMAN_SKILL_MD } from "./style-packs/caveman.ts";
import { STE_REFERENCE_FILES, STE_SKILL_MD } from "./style-packs/ste/skill.ts";

export interface WriteResult {
  path: string;
  action: InstallAction;
  note?: string;
}

export type IntegrationId =
  | "mcp"
  | "instructions"
  | "subagent"
  | "hooks"
  | "rules"
  | "caveman"
  | "ste";

/** Shared context for one install/uninstall pass (path dedupe + shared-skill keep). */
export interface ApplyCtx {
  selectedAgents: AgentTarget[];
  cavemanSeenPaths: Set<string>;
  /** Defaults to AGENT_TARGETS; override in tests. */
  allAgents?: AgentTarget[];
  /** Defaults to isAgentDetected; override in tests. */
  isDetected?: (agent: AgentTarget) => Promise<boolean>;
}

interface Integration {
  id: IntegrationId;
  label: string;
  description: string;
  experimental?: boolean;
  defaultChecked?: boolean;
  planPath: (agent: AgentTarget) => string | null;
  apply: (agent: AgentTarget, mode: InstallMode, ctx?: ApplyCtx) => Promise<WriteResult | null>;
}

const ACTION_DETAIL: Partial<Record<InstallAction, string>> = {
  skipped: "config uses comments or invalid JSON — add manually (see README)",
  error: "could not parse or edit config",
};

const ACTION_ICON: Partial<Record<InstallAction, string>> = {
  created: green("✓"),
  updated: green("✓"),
  removed: green("✓"),
  unchanged: dim("·"),
  "not-found": dim("–"),
  skipped: dim("!"),
  error: dim("✗"),
};

async function readExistingJsonMcpEntry(
  path: string,
  sectionKey: string,
  memberKey: string,
): Promise<Record<string, unknown> | null> {
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripJsonComments(await Bun.file(path).text())) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const section = (parsed as Record<string, unknown>)[sectionKey];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return null;
    }
    const entry = (section as Record<string, unknown>)[memberKey];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    return entry as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function applyMcp(agent: AgentTarget, mode: InstallMode): Promise<WriteResult | null> {
  const mcp = agent.mcp;
  if (!mcp) {
    return null;
  }

  if (mcp.format === "toml") {
    const action =
      mode === "install" ? await mergeTomlBlock(mcp.path) : await removeTomlBlock(mcp.path);
    return { path: mcp.path, action };
  }

  if (mode !== "install") {
    const action = await removeJsonMember(mcp.path, mcp.key, mcp.memberKey);
    return { path: mcp.path, action };
  }

  const existing = await readExistingJsonMcpEntry(mcp.path, mcp.key, mcp.memberKey);
  const entry = withPreservedBenchmarkFlag(mcp.entry, existing);
  const action = await mergeJsonMember(mcp.path, mcp.key, mcp.memberKey, entry);
  return { path: mcp.path, action };
}

async function applyInstructions(
  agent: AgentTarget,
  mode: InstallMode,
): Promise<WriteResult | null> {
  const path = agent.instructionsPath;
  if (!path) {
    return null;
  }

  const action =
    mode === "install" ? await replaceOrAppendMarked(path, INSTRUCTIONS) : await removeMarked(path);
  return { path, action };
}

async function applyHooks(agent: AgentTarget, mode: InstallMode): Promise<WriteResult | null> {
  const path = agent.hooksPath;
  const format = agent.hooksFormat;
  if (!path || !format) {
    return null;
  }

  const action =
    mode === "install"
      ? await mergeHooks(format, path, agent.id)
      : await removeHooks(format, path, agent.id);

  return { path, action };
}

async function applyCursorRules(
  agent: AgentTarget,
  mode: InstallMode,
): Promise<WriteResult | null> {
  const path = agent.cursorRulesPath;
  if (!path) {
    return null;
  }

  if (mode === "uninstall") {
    if (!(await Bun.file(path).exists())) {
      return { path, action: "not-found" };
    }
    await unlink(path);
    return { path, action: "removed" };
  }

  const existed = await Bun.file(path).exists();
  await Bun.write(path, `${CURSOR_RULES_MDC.trim()}\n`);
  return { path, action: existed ? "updated" : "created" };
}

async function applySubagent(agent: AgentTarget, mode: InstallMode): Promise<WriteResult | null> {
  const dest = agent.subagentPath;
  const templateId = agent.subagentId;
  if (!dest || !templateId) {
    return null;
  }

  if (mode === "uninstall") {
    if (!(await Bun.file(dest).exists())) {
      return { path: dest, action: "not-found" };
    }
    await unlink(dest);
    return { path: dest, action: "removed" };
  }

  try {
    const content = await loadAgentTemplate(templateId);
    const existed = await Bun.file(dest).exists();
    await Bun.write(dest, content);
    return { path: dest, action: existed ? "updated" : "created" };
  } catch {
    return { path: dest, action: "error" };
  }
}

async function withCodexSkillsFeature(
  agent: AgentTarget,
  result: WriteResult,
): Promise<WriteResult> {
  if (agent.id !== "codex" || !agent.mcp?.path) {
    return result;
  }
  const featureAction = await ensureCodexSkillsFeature(agent.mcp.path);
  if (featureAction === "unchanged") {
    return result;
  }
  if (result.action === "unchanged") {
    return {
      ...result,
      action: "updated",
      note: "enabled [features] skills = true in config.toml",
    };
  }
  return {
    ...result,
    note: "also sets [features] skills = true in config.toml",
  };
}

async function applyCaveman(
  agent: AgentTarget,
  mode: InstallMode,
  ctx: ApplyCtx = { selectedAgents: [agent], cavemanSeenPaths: new Set() },
): Promise<WriteResult | null> {
  const path = agent.cavemanSkillPath;
  if (!path) {
    return null;
  }

  const skillDir = dirname(path);
  const allAgents = ctx.allAgents ?? AGENT_TARGETS;
  const shared = isSharedCavemanPath(path, allAgents);
  const sharedCtx = {
    selectedAgents: ctx.selectedAgents,
    allAgents: ctx.allAgents,
    isDetected: ctx.isDetected,
  };

  if (mode === "uninstall") {
    if (shared) {
      const decision = await resolveSharedCavemanUninstall(path, skillDir, agent, sharedCtx);
      if (decision.kind === "defer" || decision.kind === "keep") {
        return { path, action: "unchanged", note: decision.note };
      }
    }
    return { path, action: await removeCavemanSkillFiles(path, skillDir) };
  }

  if (shared) {
    await ensureSharedCavemanOwnersOnInstall(skillDir, path, agent, sharedCtx);
  }

  if (ctx.cavemanSeenPaths.has(path)) {
    return { path, action: "unchanged", note: "shared skill path already written" };
  }
  ctx.cavemanSeenPaths.add(path);

  const existed = await Bun.file(path).exists();
  if (existed && (await Bun.file(path).text()) === CAVEMAN_SKILL_MD) {
    return withCodexSkillsFeature(agent, { path, action: "unchanged" });
  }

  await mkdir(skillDir, { recursive: true });
  await Bun.write(path, CAVEMAN_SKILL_MD);
  return withCodexSkillsFeature(agent, {
    path,
    action: existed ? "updated" : "created",
  });
}

async function applySte(agent: AgentTarget, mode: InstallMode): Promise<WriteResult | null> {
  const skillDir = agent.steSkillDir;
  if (!skillDir) {
    return null;
  }

  const skillPath = join(skillDir, "SKILL.md");

  if (mode === "uninstall") {
    // Require Miru's SKILL.md before deleting the tree — do not wipe a
    // third-party ~/.…/skills/ste directory that Miru never installed.
    if (!(await Bun.file(skillPath).exists())) {
      return { path: skillPath, action: "not-found" };
    }
    await rm(skillDir, { recursive: true, force: true });
    return { path: skillPath, action: "removed" };
  }

  const existed = await Bun.file(skillPath).exists();
  await mkdir(join(skillDir, "references"), { recursive: true });
  await Bun.write(skillPath, STE_SKILL_MD);
  for (const file of STE_REFERENCE_FILES) {
    await Bun.write(join(skillDir, file.relativePath), file.content);
  }
  return { path: skillPath, action: existed ? "updated" : "created" };
}

const INTEGRATIONS: Integration[] = [
  {
    id: "mcp",
    label: "MCP server",
    description: "Miru search tools via MCP",
    planPath: (agent) => agent.mcp?.path ?? null,
    apply: applyMcp,
  },
  {
    id: "instructions",
    label: "Instructions",
    description: "search policy in agent docs",
    planPath: (agent) => agent.instructionsPath,
    apply: applyInstructions,
  },
  {
    id: "subagent",
    label: "Sub-agent",
    description: "miru-code sub-agent file",
    planPath: (agent) => agent.subagentPath,
    apply: applySubagent,
  },
  {
    id: "rules",
    label: "Cursor rules",
    description: "search policy in .cursor/rules",
    planPath: (agent) => agent.cursorRulesPath,
    apply: applyCursorRules,
  },
  {
    id: "hooks",
    label: "Search hooks",
    description: "blocks built-in search; routes to Miru MCP",
    experimental: true,
    defaultChecked: false,
    planPath: (agent) => agent.hooksPath,
    apply: applyHooks,
  },
  {
    id: "caveman",
    label: "Caveman",
    description: "on-demand chat compression skill (/caveman)",
    experimental: true,
    defaultChecked: false,
    planPath: (agent) => agent.cavemanSkillPath,
    apply: applyCaveman,
  },
  {
    id: "ste",
    label: "STE writing",
    description: "on-demand clear technical English for docs (/ste)",
    experimental: true,
    defaultChecked: false,
    planPath: (agent) => (agent.steSkillDir ? join(agent.steSkillDir, "SKILL.md") : null),
    apply: applySte,
  },
];

function integrationApplies(integration: Integration, agent: AgentTarget): boolean {
  return integration.planPath(agent) !== null;
}

function integrationsForAgents(agents: AgentTarget[]): Integration[] {
  return INTEGRATIONS.filter((integration) =>
    agents.some((agent) => integrationApplies(integration, agent)),
  );
}

function formatActionLine(integration: Integration, result: WriteResult): string {
  const icon = ACTION_ICON[result.action] ?? dim("·");
  const detail = result.note ?? ACTION_DETAIL[result.action];
  const suffix = detail ? dim(` — ${detail}`) : "";
  return `   ${icon} ${integration.label.padEnd(13)} ${dim(result.action)}${suffix}\n      ${dim(result.path)}`;
}

/** Plan footnote for Codex + Caveman; null when nothing should be shown. */
export function codexCavemanPlanNote(
  mode: InstallMode,
  skillsFeatureEnabled: boolean,
): string | null {
  if (mode === "install") {
    return "also sets [features] skills = true in ~/.codex/config.toml";
  }
  if (skillsFeatureEnabled) {
    return "leaves [features] skills = true in ~/.codex/config.toml";
  }
  return null;
}

async function printPlan(
  mode: InstallMode,
  agents: AgentTarget[],
  integrations: Integration[],
): Promise<void> {
  writeStdout("");
  writeStdout(dim("Plan"));
  divider();

  for (const agent of agents) {
    writeStdout(` ${agent.displayName}`);
    for (const integration of integrations) {
      const path = integration.planPath(agent);
      if (!path) {
        continue;
      }
      writeStdout(`   ${green("✓")} ${integration.label.padEnd(13)} ${path}`);
      if (integration.id === "caveman" && agent.id === "codex") {
        let skillsEnabled = false;
        const configPath = agent.mcp?.path;
        if (mode === "uninstall" && configPath && (await Bun.file(configPath).exists())) {
          skillsEnabled = codexSkillsFeatureEnabled(await Bun.file(configPath).text());
        }
        const note = codexCavemanPlanNote(mode, skillsEnabled);
        if (note) {
          writeStdout(`      ${dim(note)}`);
        }
      }
    }
  }
  writeStdout("");
}

async function apply(
  mode: InstallMode,
  agents: AgentTarget[],
  integrations: Integration[],
): Promise<void> {
  writeStdout("");
  writeStdout(dim(mode === "install" ? "Installing" : "Removing"));
  divider();

  const ctx: ApplyCtx = {
    selectedAgents: agents,
    cavemanSeenPaths: new Set(),
  };

  for (const agent of agents) {
    writeStdout(` ${agent.displayName}`);
    for (const integration of integrations) {
      if (!integrationApplies(integration, agent)) {
        continue;
      }
      const result = await integration.apply(agent, mode, ctx);
      if (!result) {
        continue;
      }
      writeStdout(formatActionLine(integration, result));
    }
  }
  writeStdout("");
}

/** Local Miru state cleaned up during uninstall (global, not per-agent). */
export async function removeUninstallLocalData(): Promise<{
  benchmarkHistoryCleared: boolean;
  benchmarkHistoryPath: string;
}> {
  const result = await clearBenchmarkHistory();
  return {
    benchmarkHistoryCleared: result.cleared,
    benchmarkHistoryPath: result.path,
  };
}

export async function runInstaller(mode: InstallMode): Promise<void> {
  const install = mode === "install";
  requireInteractiveTerminal(`miru ${mode}`);

  if (install) {
    await ensureCredentials({ interactive: true });
  }

  writeStdout("");
  writeStdout(`${brandTitle()}${install ? " installer" : " uninstaller"}`);
  divider();
  hint("↑↓ move  space select  enter confirm");

  const detected = await Promise.all(
    AGENT_TARGETS.map(async (agent) => ({
      agent,
      detected: await isAgentDetected(agent),
    })),
  );

  const agentItems = detected.map(({ agent, detected: isDetected }) => ({
    label: `${agent.displayName}${isDetected ? dim(" (detected)") : ""}`,
    value: agent,
    checked: isDetected && install,
  }));

  const chosenAgents = await promptMultiSelect(
    `Agents to ${install ? "configure" : "clean up"}`,
    agentItems,
  );

  if (!chosenAgents || chosenAgents.length === 0) {
    hint("Nothing selected. Exiting.");
    return;
  }

  const availableIntegrations = integrationsForAgents(chosenAgents);
  if (availableIntegrations.length === 0) {
    hint("No integrations apply to the selected agents. Exiting.");
    return;
  }

  const integrationItems = availableIntegrations.map((integration) => ({
    label: `${integration.label}${integration.experimental ? dim(" (experimental)") : ""} — ${integration.description}`,
    value: integration,
    checked: install ? (integration.defaultChecked ?? true) : true,
  }));

  const chosenIntegrations = await promptMultiSelect(
    `Integrations to ${install ? "enable" : "remove"}`,
    integrationItems,
  );

  if (!chosenIntegrations || chosenIntegrations.length === 0) {
    hint("Nothing selected. Exiting.");
    return;
  }

  await printPlan(mode, chosenAgents, chosenIntegrations);

  const proceed = await promptConfirm(install ? "Proceed?" : "Remove miru configuration?", install);
  if (!proceed) {
    hint("Cancelled.");
    return;
  }

  await apply(mode, chosenAgents, chosenIntegrations);

  if (!install) {
    const local = await removeUninstallLocalData();
    if (local.benchmarkHistoryCleared) {
      info(`Removed benchmark report ${local.benchmarkHistoryPath}`);
    }
  }

  success(install ? "Done. Restart agents to apply changes." : "Done. Configuration removed.");
  writeStdout("");
}

export {
  applyCaveman,
  applyHooks,
  applyInstructions,
  applyMcp,
  applySte,
  applySubagent,
  INTEGRATIONS,
  integrationsForAgents,
  mergeJsonMember as mergeMcpJson,
  removeJsonMember as removeMcpJson,
};
