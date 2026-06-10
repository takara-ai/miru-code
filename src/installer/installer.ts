import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadAgentTemplate } from "../agents.ts";
import { brandTitle, dim, divider, green, hint, success, writeStdout } from "../cli-ui.ts";
import { ensureCredentials } from "../setup.ts";
import {
  AGENT_TARGETS,
  type AgentTarget,
  INSTRUCTIONS,
  type InstallAction,
  type InstallMode,
  isAgentDetected,
} from "./agents.ts";
import {
  mergeJsonMember,
  mergeTomlBlock,
  removeJsonMember,
  removeMarked,
  removeTomlBlock,
  replaceOrAppendMarked,
} from "./config.ts";
import { mergeHooks, removeHooks } from "./hooks/install.ts";
import { promptConfirm, promptMultiSelect, requireInteractiveTerminal } from "./prompt.ts";
import { CURSOR_RULES_MDC } from "./search-policy.ts";

export interface WriteResult {
  path: string;
  action: InstallAction;
}

export type IntegrationId = "mcp" | "instructions" | "subagent" | "hooks" | "rules";

interface Integration {
  id: IntegrationId;
  label: string;
  description: string;
  planPath: (agent: AgentTarget) => string | null;
  apply: (agent: AgentTarget, mode: InstallMode) => Promise<WriteResult | null>;
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

  const action =
    mode === "install"
      ? await mergeJsonMember(mcp.path, mcp.key, mcp.memberKey, mcp.entry)
      : await removeJsonMember(mcp.path, mcp.key, mcp.memberKey);
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
    mode === "install" ? await mergeHooks(format, path) : await removeHooks(format, path);

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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${CURSOR_RULES_MDC.trim()}\n`, "utf-8");
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
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf-8");
    return { path: dest, action: existed ? "updated" : "created" };
  } catch {
    return { path: dest, action: "error" };
  }
}

const INTEGRATIONS: Integration[] = [
  {
    id: "mcp",
    label: "MCP server",
    description: "lets the agent call miru directly as a tool",
    planPath: (agent) => agent.mcp?.path ?? null,
    apply: applyMcp,
  },
  {
    id: "instructions",
    label: "Instructions",
    description: "adds CLI usage guidance to CLAUDE.md / AGENTS.md",
    planPath: (agent) => agent.instructionsPath,
    apply: applyInstructions,
  },
  {
    id: "subagent",
    label: "Sub-agent",
    description: "installs a dedicated miru-code sub-agent",
    planPath: (agent) => agent.subagentPath,
    apply: applySubagent,
  },
  {
    id: "rules",
    label: "Cursor rules",
    description: "always-on .cursor/rules policy for code search",
    planPath: (agent) => agent.cursorRulesPath,
    apply: applyCursorRules,
  },
  {
    id: "hooks",
    label: "Search hooks",
    description: "blocks Grep/Glob and redirects agents to Miru MCP",
    planPath: (agent) => agent.hooksPath,
    apply: applyHooks,
  },
];

function formatActionLine(integration: Integration, result: WriteResult): string {
  const icon = ACTION_ICON[result.action] ?? dim("·");
  const detail = ACTION_DETAIL[result.action];
  const suffix = detail ? dim(` — ${detail}`) : "";
  return `   ${icon} ${integration.label.padEnd(13)} ${dim(result.action)}${suffix}\n      ${dim(result.path)}`;
}

function printPlan(agents: AgentTarget[], integrations: Integration[]): void {
  writeStdout("");
  writeStdout(dim("Plan"));
  divider();

  for (const agent of agents) {
    writeStdout(` ${agent.displayName}`);
    for (const integration of integrations) {
      const path = integration.planPath(agent);
      const icon = path ? green("✓") : dim("–");
      writeStdout(`   ${icon} ${integration.label.padEnd(13)} ${path ?? dim("(not supported)")}`);
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

  for (const agent of agents) {
    writeStdout(` ${agent.displayName}`);
    for (const integration of integrations) {
      const result = await integration.apply(agent, mode);
      if (!result) {
        writeStdout(`   ${dim("–")} ${integration.id.padEnd(13)} ${dim("not supported")}`);
        continue;
      }
      writeStdout(formatActionLine(integration, result));
    }
  }
  writeStdout("");
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

  const integrationItems = INTEGRATIONS.map((integration) => ({
    label: `${integration.label} — ${integration.description}`,
    value: integration,
    checked: true,
  }));

  const chosenIntegrations = await promptMultiSelect(
    `Integrations to ${install ? "enable" : "remove"}`,
    integrationItems,
  );

  if (!chosenIntegrations || chosenIntegrations.length === 0) {
    hint("Nothing selected. Exiting.");
    return;
  }

  printPlan(chosenAgents, chosenIntegrations);

  const proceed = await promptConfirm(install ? "Proceed?" : "Remove miru configuration?", install);
  if (!proceed) {
    hint("Cancelled.");
    return;
  }

  await apply(mode, chosenAgents, chosenIntegrations);

  success(
    install ? "Done! Restart your agents to pick up changes." : "Done! Configuration removed.",
  );
  if (install) {
    hint("Restart agents after install. Hooks block built-in search in favor of Miru MCP.");
  }
  writeStdout("");
}

export {
  applyHooks,
  applyInstructions,
  applyMcp,
  applySubagent,
  INTEGRATIONS,
  mergeJsonMember as mergeMcpJson,
  removeJsonMember as removeMcpJson,
};
