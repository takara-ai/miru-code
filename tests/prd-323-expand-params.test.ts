import { describe, expect, test } from "bun:test";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

async function callExpand(
  args: Record<string, unknown>,
  id = 2,
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
      id,
      method: "tools/call",
      params: {
        name: "expand",
        arguments: args,
      },
    },
  ]);

  await server.connect(transport);
  return transport.responseFor(id);
}

describe("PRD-323: expand accepts search-hit line field names", () => {
  const repo = "/definitely/not/a/real/path/for/miru";

  test("anchor_line passes schema validation", async () => {
    const response = await callExpand({
      file_path: "src/mcp/server.ts",
      anchor_line: 94,
      repo,
    });
    expect(response).toBeDefined();
    expect(response && "error" in response).toBe(false);
  });

  test("start_line passes schema validation", async () => {
    const response = await callExpand(
      {
        file_path: "src/mcp/server.ts",
        start_line: 82,
        repo,
      },
      3,
    );
    expect(response).toBeDefined();
    expect(response && "error" in response).toBe(false);
  });

  test("line still works", async () => {
    const response = await callExpand(
      {
        file_path: "src/mcp/server.ts",
        line: 94,
        repo,
      },
      4,
    );
    expect(response).toBeDefined();
    expect(response && "error" in response).toBe(false);
  });
});
