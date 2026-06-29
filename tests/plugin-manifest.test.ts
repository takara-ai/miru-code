import { expect, test } from "bun:test";

test("Codex, Claude, and Cursor plugin manifests point at the Miru MCP runtime", async () => {
  const codexPlugin = JSON.parse(
    await Bun.file(new URL("../.codex-plugin/plugin.json", import.meta.url)).text(),
  ) as {
    name: string;
    skills?: string;
    mcpServers: string;
    interface: { displayName: string };
  };
  const claudePlugin = JSON.parse(
    await Bun.file(new URL("../.claude-plugin/plugin.json", import.meta.url)).text(),
  ) as {
    name: string;
    skills: string[];
  };
  const cursorPlugin = JSON.parse(
    await Bun.file(new URL("../plugin.json", import.meta.url)).text(),
  ) as {
    name: string;
    skills: string;
    rules: string;
    mcpServers: string;
  };
  const mcp = JSON.parse(await Bun.file(new URL("../.mcp.json", import.meta.url)).text()) as {
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };

  expect(codexPlugin.name).toBe("miru");
  expect(codexPlugin.skills).toBe("./skills/");
  expect(codexPlugin.mcpServers).toBe("./.mcp.json");
  expect(codexPlugin.interface.displayName).toBe("Miru Code Search");

  expect(claudePlugin.name).toBe("miru");
  expect(claudePlugin.skills).toEqual(["./skills/"]);

  expect(cursorPlugin.name).toBe("miru");
  expect(cursorPlugin.skills).toBe("./skills/");
  expect(cursorPlugin.rules).toBe("./.cursor/rules/miru-code-search.mdc");
  expect(cursorPlugin.mcpServers).toBe("./.mcp.json");

  expect(mcp.mcpServers.miru).toEqual({
    type: "stdio",
    command: "bunx",
    args: ["@takara-ai/miru-code"],
  });
});

test("host marketplace manifests point at the Miru repo", async () => {
  const codexMarketplace = JSON.parse(
    await Bun.file(new URL("../.agents/plugins/marketplace.json", import.meta.url)).text(),
  ) as {
    plugins: Array<{
      name: string;
      source: { source: string; url: string; ref: string };
      policy: { installation: string; authentication: string };
      category: string;
    }>;
  };
  const claudeMarketplace = JSON.parse(
    await Bun.file(new URL("../.claude-plugin/marketplace.json", import.meta.url)).text(),
  ) as {
    name: string;
    plugins: Array<{
      name: string;
      description: string;
      source: string;
      category: string;
    }>;
  };

  expect(codexMarketplace.plugins[0]).toEqual({
    name: "miru",
    source: {
      source: "url",
      url: "https://github.com/takara-ai/miru-code.git",
      ref: "main",
    },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Productivity",
  });

  expect(claudeMarketplace.name).toBe("miru");
  expect(claudeMarketplace.plugins[0]).toEqual({
    name: "miru",
    description: "Repo-aware semantic code search with MCP and first-use device authentication.",
    source: "./",
    category: "productivity",
  });
});
