import { expect, test } from "bun:test";

test("Codex, Claude, and Cursor plugin manifests point at the Miru MCP runtime", async () => {
  const codexPlugin = JSON.parse(
    await Bun.file(new URL("../.codex-plugin/plugin.json", import.meta.url)).text(),
  ) as {
    name: string;
    skills?: string;
    mcpServers: string;
    interface: { displayName: string; composerIcon: string; logo: string };
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
  const kiroPlugin = JSON.parse(
    await Bun.file(new URL("../.kiro-plugin/plugin.json", import.meta.url)).text(),
  ) as {
    $schema: string;
    name: string;
    version: string;
    description: string;
    license: string;
    skills: string;
  };
  const kiroMcp = JSON.parse(
    await Bun.file(new URL("../.kiro-plugin/mcp.json", import.meta.url)).text(),
  ) as {
    $schema: string;
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };

  expect(codexPlugin.name).toBe("miru");
  expect(codexPlugin.skills).toBe("./skills/");
  expect(codexPlugin.mcpServers).toBe("./.mcp.json");
  expect(codexPlugin.interface.displayName).toBe("Miru Code Search");
  expect(codexPlugin.interface.composerIcon).toBe("./assets/takara-crane.svg");
  expect(codexPlugin.interface.logo).toBe("./assets/takara-logo.png");
  expect(
    await Bun.file(new URL("../.codex-plugin/assets/takara-crane.svg", import.meta.url)).exists(),
  ).toBe(true);
  expect(
    await Bun.file(new URL("../.codex-plugin/assets/takara-logo.png", import.meta.url)).exists(),
  ).toBe(true);

  expect(claudePlugin.name).toBe("miru");
  expect(claudePlugin.skills).toEqual(["./skills/"]);

  expect(cursorPlugin.name).toBe("miru");
  expect(cursorPlugin.skills).toBe("./skills/");
  expect(cursorPlugin.rules).toBe("./.cursor/rules/miru-code-search.mdc");
  expect(cursorPlugin.mcpServers).toBe("./.mcp.json");

  expect(mcp.mcpServers.miru).toEqual({
    type: "stdio",
    command: "bun",
    args: ["x", "@takara-ai/miru-code@latest"],
  });

  expect(kiroPlugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  expect(kiroPlugin.name).toBe("miru");
  expect(kiroPlugin.description).toBe(
    "Semantic code search for coding agents, built for AWS Transform modernization work — defaults to self-hosted SageMaker embeddings, not Takara-hosted.",
  );
  expect(kiroPlugin.license).toBe("MIT");
  expect(kiroPlugin.skills).toBe("./skills/");

  expect(kiroMcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  expect(kiroMcp.mcpServers.miru).toEqual({
    type: "stdio",
    command: "bunx",
    args: ["@takara-ai/miru-code@latest"],
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
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
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
