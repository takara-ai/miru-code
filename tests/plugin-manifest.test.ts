import { expect, test } from "bun:test";

test("repo-local Codex plugin files are wired to the published Miru package", async () => {
  const plugin = JSON.parse(
    await Bun.file(new URL("../.codex-plugin/plugin.json", import.meta.url)).text(),
  ) as {
    name: string;
    mcpServers: string;
  };
  const mcp = JSON.parse(await Bun.file(new URL("../.mcp.json", import.meta.url)).text()) as {
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };
  const marketplace = JSON.parse(
    await Bun.file(new URL("../.agents/plugins/marketplace.json", import.meta.url)).text(),
  ) as {
    plugins: Array<{
      name: string;
      source: { source: string; path: string };
      policy: { installation: string; authentication: string };
      category: string;
    }>;
  };

  expect(plugin.name).toBe("miru-code");
  expect(plugin.mcpServers).toBe("./.mcp.json");
  expect(mcp.mcpServers.miru).toEqual({
    type: "stdio",
    command: "bunx",
    args: ["@takara-ai/miru-code"],
  });
  expect(marketplace.plugins[0]).toEqual({
    name: "miru-code",
    source: { path: ".", source: "local" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Productivity",
  });
});
