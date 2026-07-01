import { describe, expect, test } from "bun:test";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

async function callExpand(
  args: Record<string, unknown>,
): Promise<ReturnType<MemoryTransport["responseFor"]>> {
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
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "expand",
        arguments: args,
      },
    },
  ]);

  await server.connect(transport);
  return transport.responseFor(2);
}

describe("PRD-323: expand uses anchor_line param", () => {
  test("anchor_line passes schema validation", async () => {
    const response = await callExpand({
      file_path: "src/mcp/server.ts",
      anchor_line: 94,
      repo: "/definitely/not/a/real/path/for/miru",
    });
    expect(response).toBeDefined();
    expect(response && "error" in response).toBe(false);
  });
});
