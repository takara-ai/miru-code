import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentTarget,
  isAgentDetected,
  isCopilotInstalled,
  opencodeConfigDir,
  opencodeMcpPath,
  visualStudioInstallDir,
  visualStudioMcpPath,
  vscodeMcpPath,
} from "../src/installer/agents.ts";

let root: string | undefined;
const previousXdg = process.env.XDG_CONFIG_HOME;
const previousProfile = process.env.USERPROFILE;
const previousAppData = process.env.APPDATA;
const previousProgramFiles = process.env.ProgramFiles;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = previousProgramFiles;
});

function target(id: AgentTarget["id"], options: Partial<AgentTarget> = {}): AgentTarget {
  return {
    id,
    displayName: String(id),
    binary: null,
    configDir: null,
    mcp: null,
    instructionsPath: null,
    cursorRulesPath: null,
    legacyHooksPath: null,
    legacyHooksFormat: null,
    subagentPath: null,
    subagentId: null,
    cavemanSkillPath: null,
    steSkillDir: null,
    ...options,
  };
}

describe("installer agent path resolution and detection", () => {
  test("uses platform paths and OpenCode JSON config precedence", async () => {
    root = await mkdtemp(join(tmpdir(), "miru-agent-paths-"));
    const home = homedir();
    process.env.XDG_CONFIG_HOME = root;
    const configDir = opencodeConfigDir(home);
    expect(configDir).toBe(join(root, "opencode"));
    expect(opencodeMcpPath()).toBe(join(configDir, "opencode.jsonc"));
    await mkdir(configDir, { recursive: true });
    await Bun.write(join(configDir, "opencode.json"), "{}");
    expect(opencodeMcpPath()).toBe(join(configDir, "opencode.json"));
    await Bun.write(join(configDir, "opencode.jsonc"), "{}");
    expect(opencodeMcpPath()).toBe(join(configDir, "opencode.jsonc"));

    process.env.USERPROFILE = root;
    expect(visualStudioMcpPath()).toBe(join(root, ".mcp.json"));
    expect(visualStudioInstallDir("linux")).toBeNull();
    expect(vscodeMcpPath("darwin")).toBe(
      join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    );
  });

  test("detects agents by executable or config directory and honors Windsurf paths", async () => {
    root = await mkdtemp(join(tmpdir(), "miru-agent-detect-"));
    expect(
      await isAgentDetected(target("cursor", { binary: "sh" }), {
        commandOnPath: async (command) => command === "sh",
      }),
    ).toBe(true);
    expect(await isAgentDetected(target("cursor", { binary: "miru-missing-command-xyz" }))).toBe(
      false,
    );
    const configPath = join(root, "settings.json");
    await Bun.write(configPath, "{}");
    expect(await isAgentDetected(target("cursor", { configDir: configPath }))).toBe(true);
    expect(await isAgentDetected(target("cursor", { configDir: join(root, "missing") }))).toBe(
      false,
    );
    expect(await isAgentDetected(target("windsurf", { configDir: root }))).toBe(true);
    expect(await isAgentDetected(target("windsurf", { binary: "miru-missing-command-xyz" }))).toBe(
      false,
    );
    expect(
      await isAgentDetected(target("cursor", { binary: "anything" }), {
        spawn: (() => {
          throw new Error("spawn failed");
        }) as typeof Bun.spawn,
      }),
    ).toBe(false);
    expect(await isAgentDetected(target("visualstudio"), { platform: "linux" })).toBe(false);
    expect(
      await isAgentDetected(target("windsurf", { binary: "windsurf" }), {
        existsSync: () => false,
        commandOnPath: async () => true,
      }),
    ).toBe(true);
  });

  test("resolves Windows and Linux agent paths and probes Visual Studio install modes", async () => {
    root = await mkdtemp(join(tmpdir(), "miru-agent-platform-paths-"));
    process.env.APPDATA = root;
    process.env.ProgramFiles = root;
    expect(vscodeMcpPath("win32")).toBe(join(root, "Code", "User", "mcp.json"));
    delete process.env.APPDATA;
    expect(vscodeMcpPath("win32")).toBe(join(homedir(), "Code", "User", "mcp.json"));
    process.env.XDG_CONFIG_HOME = root;
    expect(vscodeMcpPath("linux")).toBe(join(root, "Code", "User", "mcp.json"));
    expect(visualStudioInstallDir("win32")).toBe(join(root, "Microsoft Visual Studio"));
    expect(visualStudioInstallDir("linux")).toBeNull();

    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: () => true,
        readdir: async () => ["2022"],
      }),
    ).toBe(true);
    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: () => true,
        readdir: async () => [],
        commandOnPath: async (command) => command === "devenv",
      }),
    ).toBe(true);
    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: () => true,
        readdir: async () => {
          throw new Error("access denied");
        },
        commandOnPath: async () => false,
      }),
    ).toBe(false);
    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: () => false,
        commandOnPath: async () => {
          throw new Error("command probe failed");
        },
      }),
    ).toBe(false);
    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: () => false,
        commandOnPath: async () => false,
      }),
    ).toBe(false);
    await mkdir(join(root, "Microsoft Visual Studio"));
    expect(
      await isAgentDetected(target("visualstudio"), {
        platform: "win32",
        existsSync: (path) => path === join(root ?? "", "Microsoft Visual Studio"),
        spawn: (() => ({ exited: Promise.resolve(1) })) as unknown as typeof Bun.spawn,
      }),
    ).toBe(false);
  });

  test("checks only Copilot-specific artifacts for Copilot detection", async () => {
    root = await mkdtemp(join(tmpdir(), "miru-copilot-detect-"));
    expect(isCopilotInstalled(root)).toBe(false);
    expect(await isAgentDetected(target("copilot"), { home: root })).toBe(false);
    await mkdir(join(root, ".copilot"), { recursive: true });
    await Bun.write(join(root, ".copilot", "mcp-config.json"), "{}");
    expect(isCopilotInstalled(root)).toBe(true);
    await rm(join(root, ".copilot"), { recursive: true, force: true });
    await mkdir(join(root, ".copilot", "agents"), { recursive: true });
    expect(isCopilotInstalled(root)).toBe(true);
    expect(await isAgentDetected(target("copilot"), { home: root })).toBe(true);
    await rm(join(root, ".copilot"), { recursive: true, force: true });
    await mkdir(join(root, ".config", "github-copilot"), { recursive: true });
    expect(isCopilotInstalled(root)).toBe(true);
  });
});
