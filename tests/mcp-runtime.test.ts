import { expect, test } from "bun:test";
import packageJson from "../package.json";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

test("stdio MCP runtime handles initialize, tools/list, and tools/call", async () => {
  const server = createMcpServer(new IndexCache());
  const transport = new MemoryTransport([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "missing repo", repo: "/definitely/not/a/real/path/for/miru" },
      },
    },
  ]);

  await server.connect(transport);

  const init = transport.responseFor(1);
  expect(init).toBeDefined();
  if (!init || !("result" in init)) {
    throw new Error("missing initialize response");
  }
  const initResult = init.result as {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    instructions?: string;
    capabilities: { tools?: { listChanged: boolean } };
  };
  expect(initResult.protocolVersion).toBe("2025-03-26");
  expect(initResult.serverInfo).toEqual({ name: "miru", version: packageJson.version });
  expect(initResult.capabilities.tools?.listChanged).toBe(true);
  expect(typeof initResult.instructions).toBe("string");

  const tools = transport.responseFor(2);
  expect(tools).toBeDefined();
  if (!tools || !("result" in tools)) {
    throw new Error("missing tools/list response");
  }
  const toolNames = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map(
    (tool) => tool.name,
  );
  expect(toolNames).toEqual(["search", "expand", "find_related"]);

  const call = transport.responseFor(3);
  expect(call).toBeDefined();
  if (!call || !("result" in call)) {
    throw new Error("missing tools/call response");
  }
  const callResult = call.result as { content: Array<{ type: string; text: string }> };
  expect(callResult.content[0]?.type).toBe("text");
  expect(callResult.content[0]?.text.length).toBeGreaterThan(0);
});
