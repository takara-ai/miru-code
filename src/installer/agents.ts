import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../agents.ts";
import { INSTRUCTIONS_MARKDOWN } from "./search-policy.ts";

function copilotHooksPath(home: string): string {
  return join(home, ".copilot", "hooks", "miru-search.json");
}

function kiroHooksPath(home: string): string {
  return join(home, ".kiro", "settings", "hooks.json");
}

function windsurfHooksPath(home: string): string {
  return join(home, ".codeium", "windsurf", "hooks.json");
}

function opencodePluginPath(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, "opencode") : join(home, ".config", "opencode");
  return join(base, "plugins", "miru-search-guard.ts");
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
  enabled: true,
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

export type HooksFormat =
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
  hooksPath: string | null;
  hooksFormat: HooksFormat | null;
  subagentPath: string | null;
  subagentId: AgentId | null;
}

export function opencodeMcpPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, "opencode") : join(HOME, ".config", "opencode");
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

export function vscodeMcpPath(): string {
  if (process.platform === "darwin") {
    return join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (process.platform === "win32") {
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

export function visualStudioInstallDir(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  const programFiles = process.env.ProgramFiles ?? join("C:", "Program Files");
  return join(programFiles, "Microsoft Visual Studio");
}

async function detectVisualStudio(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const installDir = visualStudioInstallDir();
  if (installDir && existsSync(installDir)) {
    try {
      const entries = await readdir(installDir);
      if (entries.length > 0) {
        return true;
      }
    } catch {
      // ignore unreadable install directory
    }
  }

  try {
    const proc = Bun.spawn(["where", "devenv"], { stdout: "pipe", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

function jsonMcp(path: string, key: string, entry: Record<string, unknown>): McpConfig {
  return { path, key, memberKey: "miru", entry, format: "json" };
}

export const AGENT_TARGETS: AgentTarget[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    configDir: join(HOME, ".claude"),
    mcp: jsonMcp(join(HOME, ".claude.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: join(HOME, ".claude", "CLAUDE.md"),
    cursorRulesPath: null,
    hooksPath: join(HOME, ".claude", "settings.json"),
    hooksFormat: "claude",
    subagentPath: join(HOME, ".claude", "agents", "miru-code.md"),
    subagentId: "claude",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    binary: "cursor",
    configDir: join(HOME, ".cursor"),
    mcp: jsonMcp(join(HOME, ".cursor", "mcp.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: join(HOME, ".cursor", "rules", "miru-code.mdc"),
    hooksPath: join(HOME, ".cursor", "hooks.json"),
    hooksFormat: "cursor",
    subagentPath: join(HOME, ".cursor", "agents", "miru-code.md"),
    subagentId: "cursor",
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    binary: "gemini",
    configDir: join(HOME, ".gemini"),
    mcp: jsonMcp(join(HOME, ".gemini", "settings.json"), "mcpServers", STDIO_SERVER_CONFIG),
    instructionsPath: join(HOME, ".gemini", "GEMINI.md"),
    cursorRulesPath: null,
    hooksPath: join(HOME, ".gemini", "settings.json"),
    hooksFormat: "gemini",
    subagentPath: join(HOME, ".gemini", "agents", "miru-code.md"),
    subagentId: "gemini",
  },
  {
    id: "kiro",
    displayName: "Kiro",
    binary: "kiro",
    configDir: join(HOME, ".kiro"),
    mcp: jsonMcp(join(HOME, ".kiro", "settings", "mcp.json"), "mcpServers", {
      ...STDIO_SERVER_CONFIG,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
    }),
    instructionsPath: join(HOME, ".kiro", "steering", "miru.md"),
    cursorRulesPath: null,
    hooksPath: kiroHooksPath(HOME),
    hooksFormat: "kiro",
    subagentPath: join(HOME, ".kiro", "agents", "miru-code.md"),
    subagentId: "kiro",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    configDir: join(HOME, ".config", "opencode"),
    mcp: jsonMcp(opencodeMcpPath(), "mcp", OPENCODE_SERVER_CONFIG),
    instructionsPath: join(HOME, ".config", "opencode", "AGENTS.md"),
    cursorRulesPath: null,
    hooksPath: opencodePluginPath(HOME),
    hooksFormat: "opencode",
    subagentPath: join(HOME, ".config", "opencode", "agents", "miru-code.md"),
    subagentId: "opencode",
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    binary: null,
    configDir: join(HOME, ".config", "github-copilot"),
    mcp: jsonMcp(join(HOME, ".copilot", "mcp-config.json"), "mcpServers", BARE_STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: null,
    hooksPath: copilotHooksPath(HOME),
    hooksFormat: "vscode",
    subagentPath: join(HOME, ".copilot", "agents", "miru-code.agent.md"),
    subagentId: "copilot",
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
    hooksPath: join(HOME, ".codex", "hooks.json"),
    hooksFormat: "claude",
    subagentPath: null,
    subagentId: null,
  },
  {
    id: "vscode",
    displayName: "VS Code",
    binary: "code",
    configDir: null,
    mcp: jsonMcp(vscodeMcpPath(), "servers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: null,
    hooksPath: copilotHooksPath(HOME),
    hooksFormat: "vscode",
    subagentPath: null,
    subagentId: null,
  },
  {
    id: "windsurf",
    displayName: "Windsurf / Devin Desktop",
    binary: "windsurf",
    configDir: join(HOME, ".codeium", "windsurf"),
    mcp: null,
    instructionsPath: null,
    cursorRulesPath: null,
    hooksPath: windsurfHooksPath(HOME),
    hooksFormat: "windsurf",
    subagentPath: null,
    subagentId: null,
  },
  {
    id: "visualstudio",
    displayName: process.platform === "win32" ? "Visual Studio" : "Visual Studio (Windows)",
    binary: null,
    configDir: visualStudioInstallDir(),
    mcp: jsonMcp(visualStudioMcpPath(), "servers", STDIO_SERVER_CONFIG),
    instructionsPath: null,
    cursorRulesPath: null,
    hooksPath: copilotHooksPath(HOME),
    hooksFormat: "vscode",
    subagentPath: null,
    subagentId: null,
  },
];

async function commandOnPath(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? ["where", command] : ["which", command];
  try {
    const proc = Bun.spawn(lookup, { stdout: "pipe", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function isAgentDetected(agent: AgentTarget): Promise<boolean> {
  if (agent.id === "visualstudio") {
    return detectVisualStudio();
  }
  if (agent.id === "windsurf") {
    if (agent.configDir && existsSync(agent.configDir)) {
      return true;
    }
    if (agent.binary && (await commandOnPath(agent.binary))) {
      return true;
    }
    return false;
  }
  if (agent.binary && (await commandOnPath(agent.binary))) {
    return true;
  }
  if (agent.configDir) {
    return Bun.file(agent.configDir).exists();
  }
  return false;
}
