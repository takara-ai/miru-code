import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../agents.ts";
import { INSTRUCTIONS_MARKDOWN } from "./search-policy.ts";

/** Shared Copilot / VS Code / Visual Studio config root (MCP, agents). */
export function copilotHomeDir(home: string): string {
  return join(home, ".copilot");
}

/**
 * Vendors that do not scan `~/.agents/skills/` and need a native skill dir
 * (Caveman + STE).
 */
export type NativeSkillVendor = "claude" | "kiro";

/** @deprecated Use NativeSkillVendor. */
export type NativeCavemanVendor = NativeSkillVendor;

function skillMd(home: string, rootDir: string, skillName: string): string {
  return join(home, rootDir, "skills", skillName, "SKILL.md");
}

function skillDir(home: string, rootDir: string, skillName: string): string {
  return join(home, rootDir, "skills", skillName);
}

/**
 * Cross-agent Agent Skills root (`~/.agents/skills/…`).
 * Used by Cursor, Gemini, OpenCode, Codex, Windsurf, and Copilot-family IDEs.
 * Claude Code and Kiro still use vendor-native skill dirs.
 */
export function agentsCavemanSkillPath(home: string): string {
  return skillMd(home, ".agents", "caveman");
}

/** Claude Code / Kiro native Caveman skill path. */
export function nativeCavemanSkillPath(home: string, vendor: NativeSkillVendor): string {
  return skillMd(home, `.${vendor}`, "caveman");
}

/** Shared STE skill directory under `~/.agents/skills/ste`. */
export function agentsSteSkillDir(home: string): string {
  return skillDir(home, ".agents", "ste");
}

/** Claude Code / Kiro native STE skill directory. */
export function nativeSteSkillDir(home: string, vendor: NativeSkillVendor): string {
  return skillDir(home, `.${vendor}`, "ste");
}

/** OpenCode config root (`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`). */
export function opencodeConfigDir(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "opencode") : join(home, ".config", "opencode");
}

export type InstallAction =
  | "created"
  | "updated"
  | "unchanged"
  | "not-found"
  | "removed"
  | "error"
  | "skipped";

export type InstallMode = "install" | "uninstall";

export const MIRU_START = "<!-- miru:start -->";
export const MIRU_END = "<!-- miru:end -->";

const HOME = homedir();

const STDIO_SERVER_CONFIG: Record<string, unknown> = {
  command: "bunx",
  args: ["@takara-ai/miru-code"],
  type: "stdio",
};

const BARE_STDIO_SERVER_CONFIG: Record<string, unknown> = {
  command: "bunx",
  args: ["@takara-ai/miru-code"],
};

const OPENCODE_SERVER_CONFIG: Record<string, unknown> = {
  command: ["bunx", "@takara-ai/miru-code"],
  type: "local",
};

export const INSTRUCTIONS = `${MIRU_START}
${INSTRUCTIONS_MARKDOWN}
${MIRU_END}
`;

export type McpConfigFormat = "json" | "toml";

export interface McpConfig {
  path: string;
  key: string;
  memberKey: string;
  entry: Record<string, unknown>;
  format: McpConfigFormat;
}

export type LegacyHooksFormat =
  | "claude"
  | "cursor"
  | "gemini"
  | "vscode"
  | "kiro"
  | "windsurf"
  | "opencode";

export interface AgentTarget {
  id: AgentId | "codex" | "vscode" | "visualstudio" | "windsurf";
  displayName: string;
  binary: string | null;
  configDir: string | null;
  mcp: McpConfig | null;
  instructionsPath: string | null;
  cursorRulesPath: string | null;
  /** Search-hook paths are retained for uninstalling hooks created by older releases. */
  legacyHooksPath: string | null;
  legacyHooksFormat: LegacyHooksFormat | null;
  subagentPath: string | null;
  subagentId: AgentId | null;
  /**
   * On-demand Caveman Agent Skill (`…/skills/caveman/SKILL.md`), or null if
   * unsupported.
   */
  cavemanSkillPath: string | null;
  /**
   * On-demand STE skill directory (`…/skills/ste/`), or null if unsupported.
   */
  steSkillDir: string | null;
}

export function opencodeMcpPath(): string {
  const base = opencodeConfigDir(HOME);
  const jsonc = join(base, "opencode.jsonc");
  const json = join(base, "opencode.json");
  if (existsSync(jsonc)) {
    return jsonc;
  }
  if (existsSync(json)) {
    return json;
  }
  return jsonc;
}

export function vscodeMcpPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? HOME;
    return join(appData, "Code", "User", "mcp.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(HOME, ".config");
  return join(xdg, "Code", "User", "mcp.json");
}

/** Global MCP config for Visual Studio (GitHub Copilot Agent Mode). */
export function visualStudioMcpPath(): string {
  const profile = process.env.USERPROFILE ?? HOME;
  return join(profile, ".mcp.json");
}

export function visualStudioInstallDir(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") {
    return null;
  }
  const programFiles = process.env.ProgramFiles ?? join("C:", "Program Files");
  return join(programFiles, "Microsoft Visual Studio");
}

async function detectVisualStudio(dependencies: AgentDetectionDependencies = {}): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }

  const installDir = visualStudioInstallDir(platform);
  const pathExists = dependencies.existsSync ?? existsSync;
  if (installDir && pathExists(installDir)) {
    try {
      const entries = await (dependencies.readdir ?? ((path: string) => readdir(path)))(installDir);
      if (entries.length > 0) {
        return true;
      }
    } catch {
      // ignore unreadable install directory
    }
  }

  try {
    return await (dependencies.commandOnPath
      ? dependencies.commandOnPath("devenv")
      : commandOnPath("devenv", platform, dependencies.spawn));
  } catch {
    return false;
  }
}

function jsonMcp(path: string, key: string, entry: Record<string, unknown>): McpConfig {
  return { path, key, memberKey: "miru", entry, format: "json" };
}

const SHARED_CAVEMAN_SKILL = agentsCavemanSkillPath(HOME);
const SHARED_STE_SKILL_DIR = agentsSteSkillDir(HOME);

export const AGENT_TARGETS: AgentTarget[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    configDir: join(HOME, ".claude"),
    mcp: jsonMcp(join(HOME, ".claude.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: join(HOME, ".claude", "CLAUDE.md"),
    cursorRulesPath: null,
    legacyHooksPath: join(HOME, ".claude", "settings.json"),
    legacyHooksFormat: "claude",
    subagentPath: join(HOME, ".claude", "agents", "miru-code.md"),
    subagentId: "claude",
    cavemanSkillPath: nativeCavemanSkillPath(HOME, "claude"),
    steSkillDir: nativeSteSkillDir(HOME, "claude"),
  },
  {
    id: "cursor",
    displayName: "Cursor",
    binary: "cursor",
    configDir: join(HOME, ".cursor"),
    mcp: jsonMcp(join(HOME, ".cursor", "mcp.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: join(HOME, ".cursor", "rules", "miru-code.mdc"),
    legacyHooksPath: join(HOME, ".cursor", "hooks.json"),
    legacyHooksFormat: "cursor",
    subagentPath: join(HOME, ".cursor", "agents", "miru-code.md"),
    subagentId: "cursor",
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    binary: "gemini",
    configDir: join(HOME, ".gemini"),
    mcp: jsonMcp(join(HOME, ".gemini", "settings.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: join(HOME, ".gemini", "GEMINI.md"),
    cursorRulesPath: null,
    legacyHooksPath: join(HOME, ".gemini", "settings.json"),
    legacyHooksFormat: "gemini",
    subagentPath: join(HOME, ".gemini", "agents", "miru-code.md"),
    subagentId: "gemini",
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "kiro",
    displayName: "Kiro",
    binary: "kiro",
    configDir: join(HOME, ".kiro"),
    mcp: jsonMcp(join(HOME, ".kiro", "settings", "mcp.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: join(HOME, ".kiro", "steering", "miru.md"),
    cursorRulesPath: null,
    legacyHooksPath: join(HOME, ".kiro", "settings", "hooks.json"),
    legacyHooksFormat: "kiro",
    subagentPath: join(HOME, ".kiro", "agents", "miru-code.md"),
    subagentId: "kiro",
    cavemanSkillPath: nativeCavemanSkillPath(HOME, "kiro"),
    steSkillDir: nativeSteSkillDir(HOME, "kiro"),
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    configDir: opencodeConfigDir(HOME),
    mcp: jsonMcp(opencodeMcpPath(), "mcp.servers", OPENCODE_SERVER_CONFIG),
    instructionsPath: join(opencodeConfigDir(HOME), "AGENTS.md"),
    cursorRulesPath: null,
    legacyHooksPath: join(opencodeConfigDir(HOME), "plugins", "miru-search-guard.ts"),
    legacyHooksFormat: "opencode",
    subagentPath: join(opencodeConfigDir(HOME), "agents", "miru-code.md"),
    subagentId: "opencode",
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    binary: null,
    configDir: join(HOME, ".config", "github-copilot"),
    mcp: jsonMcp(
      join(copilotHomeDir(HOME), "mcp-config.json"),
      "mcpServers",
      BARE_STDIO_SERVER_CONFIG,
    ),
    instructionsPath: null,
    cursorRulesPath: null,
    legacyHooksPath: join(copilotHomeDir(HOME), "hooks", "miru-search.json"),
    legacyHooksFormat: "vscode",
    subagentPath: join(copilotHomeDir(HOME), "agents", "miru-code.agent.md"),
    subagentId: "copilot",
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    configDir: join(HOME, ".codex"),
    mcp: {
      path: join(HOME, ".codex", "config.toml"),
      key: "mcp_servers",
      memberKey: "miru",
      entry: {},
      format: "toml",
    },
    instructionsPath: join(HOME, ".codex", "AGENTS.md"),
    cursorRulesPath: null,
    legacyHooksPath: join(HOME, ".codex", "hooks.json"),
    legacyHooksFormat: "claude",
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "vscode",
    displayName: "VS Code",
    binary: "code",
    configDir: null,
    mcp: jsonMcp(vscodeMcpPath(), "servers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: null,
    legacyHooksPath: join(copilotHomeDir(HOME), "hooks", "miru-search.json"),
    legacyHooksFormat: "vscode",
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "windsurf",
    displayName: "Windsurf / Devin Desktop",
    binary: "windsurf",
    configDir: join(HOME, ".codeium", "windsurf"),
    mcp: null,
    instructionsPath: null,
    cursorRulesPath: null,
    legacyHooksPath: join(HOME, ".codeium", "windsurf", "hooks.json"),
    legacyHooksFormat: "windsurf",
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
  {
    id: "visualstudio",
    displayName: process.platform === "win32" ? "Visual Studio" : "Visual Studio (Windows)",
    binary: null,
    configDir: visualStudioInstallDir(),
    mcp: jsonMcp(visualStudioMcpPath(), "servers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: null,
    legacyHooksPath: join(copilotHomeDir(HOME), "hooks", "miru-search.json"),
    legacyHooksFormat: "vscode",
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: SHARED_CAVEMAN_SKILL,
    steSkillDir: SHARED_STE_SKILL_DIR,
  },
];

async function commandOnPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<boolean> {
  const lookup = platform === "win32" ? ["where", command] : ["which", command];
  try {
    const proc = spawn(lookup, { stdout: "pipe", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export interface AgentDetectionDependencies {
  platform?: NodeJS.Platform;
  existsSync?: typeof existsSync;
  readdir?: (path: string) => Promise<string[]>;
  commandOnPath?: (command: string) => Promise<boolean>;
  spawn?: typeof Bun.spawn;
  home?: string;
}

export async function isAgentDetected(
  agent: AgentTarget,
  dependencies: AgentDetectionDependencies = {},
): Promise<boolean> {
  if (agent.id === "visualstudio") {
    return detectVisualStudio(dependencies);
  }
  if (agent.id === "windsurf") {
    if (agent.configDir && (dependencies.existsSync ?? existsSync)(agent.configDir)) {
      return true;
    }
    const commandExists = dependencies.commandOnPath
      ? dependencies.commandOnPath
      : (command: string) => commandOnPath(command, dependencies.platform, dependencies.spawn);
    if (agent.binary && (await commandExists(agent.binary))) {
      return true;
    }
    return false;
  }
  // Copilot-specific artifacts only — ~/.copilot alone is shared with VS Code / VS.
  if (agent.id === "copilot") {
    return isCopilotInstalled(dependencies.home ?? HOME);
  }
  const commandExists = dependencies.commandOnPath
    ? dependencies.commandOnPath
    : (command: string) => commandOnPath(command, dependencies.platform, dependencies.spawn);
  if (agent.binary && (await commandExists(agent.binary))) {
    return true;
  }
  if (agent.configDir) {
    return Bun.file(agent.configDir).exists();
  }
  return false;
}

/**
 * True when Copilot-specific config exists. Does not treat shared
 * `~/.copilot` hooks (also used by VS Code / Visual Studio) as enough.
 */
export function isCopilotInstalled(home: string = HOME): boolean {
  if (existsSync(join(home, ".config", "github-copilot"))) {
    return true;
  }
  const copilot = copilotHomeDir(home);
  if (existsSync(join(copilot, "mcp-config.json"))) {
    return true;
  }
  if (existsSync(join(copilot, "agents"))) {
    return true;
  }
  return false;
}
