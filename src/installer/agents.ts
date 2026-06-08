import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../agents.ts";

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

const TAKARA_KEY_PLACEHOLDER = "$" + "{TAKARA_API_KEY}";

const MCP_ENV: Record<string, string> = {
  TAKARA_API_KEY: TAKARA_KEY_PLACEHOLDER,
};

const STDIO_SERVER_CONFIG: Record<string, unknown> = {
  command: "bunx",
  args: ["@takara-ai/miru-code"],
  type: "stdio",
  env: MCP_ENV,
};

const BARE_STDIO_SERVER_CONFIG: Record<string, unknown> = {
  command: "bunx",
  args: ["@takara-ai/miru-code"],
  env: MCP_ENV,
};

const OPENCODE_SERVER_CONFIG: Record<string, unknown> = {
  command: ["bunx", "@takara-ai/miru-code"],
  type: "local",
  enabled: true,
  environment: MCP_ENV,
};

export const INSTRUCTIONS = `${MIRU_START}
## Miru Code Search

A \`miru\` MCP server is available with two tools:
- \`search\` — search the codebase with a natural-language or code query.
- \`find_related\` — find code similar to a specific file and line.

Always call \`search\` before using Grep, Glob, or Read to explore the codebase. Use Grep/Glob/Read only for exact path lookup, exhaustive literal matches, or when the returned chunk lacks enough context.

Run \`miru setup\` once to store your API key — the MCP server loads it from \`credentials.json\`. Optionally set \`TAKARA_API_KEY\` in MCP config to override.

Pass \`--content docs\` to search documentation, \`--content config\` for config files, or \`--content all\` for everything.

For CLI fallback or sub-agents without MCP access:

\`\`\`bash
miru search "authentication flow" ./my-project
miru search "deployment guide" ./my-project --content docs
miru find-related src/auth.ts 42 ./my-project
miru search "save model to disk" ./my-project --top-k 10
\`\`\`

First run builds a disk cache. The MCP server updates local indexes while it runs; after CLI-only use or large refactors, run \`miru clear <path>\`.

If \`miru\` is not on \`$PATH\`, use \`bunx @takara-ai/miru-code\` in its place.

### Workflow

1. Start with \`search\` (MCP) or \`miru search\` (CLI) to find relevant chunks.
2. Use \`--content docs\` / \`--content config\` / \`--content all\` when appropriate.
3. Inspect full files only when the chunk is not enough.
4. Optionally use \`find_related\` with a hit's \`file_path\` and \`line\`.
5. Use Grep only for exhaustive literal matches.
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

export interface AgentTarget {
  id: AgentId | "codex" | "vscode";
  displayName: string;
  binary: string | null;
  configDir: string | null;
  mcp: McpConfig | null;
  instructionsPath: string | null;
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
        ...MCP_ENV,
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
    }),
    instructionsPath: join(HOME, ".kiro", "steering", "miru.md"),
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
    subagentPath: null,
    subagentId: null,
  },
];

export async function isAgentDetected(agent: AgentTarget): Promise<boolean> {
  if (agent.binary) {
    try {
      const proc = Bun.spawn(["which", agent.binary], { stdout: "pipe", stderr: "ignore" });
      const code = await proc.exited;
      if (code === 0) {
        return true;
      }
    } catch {
      // which unavailable
    }
  }
  if (agent.configDir) {
    return Bun.file(agent.configDir).exists();
  }
  return false;
}
