import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/stdio.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";
import {
  assertJsonRpcError,
  assertJsonRpcResultMatches,
  assertMatchesOfficialMcpSchema,
} from "./helpers/mcp-schema-validator.ts";

async function runHandshake(options?: {
  protocolVersion?: string;
  repo?: string;
}): Promise<MemoryTransport> {
  const repo = options?.repo ?? (await mkdtemp(join(tmpdir(), "miru-mcp-schema-")));
  const server = createMcpServer(new IndexCache());
  const transport = new MemoryTransport([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: options?.protocolVersion ?? "2025-11-25",
        capabilities: {},
        clientInfo: { name: "schema-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "entry point", repo },
      },
    },
  ]);

  await server.connect(transport);
  return transport;
}

describe("native MCP server matches official 2025-11-25 schema", () => {
  test("initialize, ping, tools/list, and tools/call responses validate", async () => {
    const transport = await runHandshake();

    assertJsonRpcResultMatches(transport.responseFor(1), "InitializeResult");
    assertJsonRpcResultMatches(transport.responseFor(2), "EmptyResult");
    assertJsonRpcResultMatches(transport.responseFor(3), "ListToolsResult");
    assertJsonRpcResultMatches(transport.responseFor(4), "CallToolResult");

    for (const message of transport.sent) {
      assertMatchesOfficialMcpSchema("JSONRPCMessage", message);
    }
  });

  test("each listed tool validates against Tool", async () => {
    const transport = await runHandshake();
    const list = transport.responseFor(3);
    if (!list || !("result" in list)) {
      throw new Error("missing tools/list response");
    }

    const tools = (list.result as { tools: unknown[] }).tools;
    expect(tools.length).toBe(3);
    for (const tool of tools) {
      assertMatchesOfficialMcpSchema("Tool", tool);
    }
  });

  test("negotiates every supported protocol version", async () => {
    for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
      const server = createMcpServer(new IndexCache());
      const transport = new MemoryTransport([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "schema-test", version: "1.0.0" },
          },
        },
      ]);

      await server.connect(transport);
      const init = transport.responseFor(1);
      assertJsonRpcResultMatches(init, "InitializeResult");
      if (!init || !("result" in init)) {
        throw new Error("missing initialize response");
      }
      expect((init.result as { protocolVersion: string }).protocolVersion).toBe(protocolVersion);
    }
  });

  test("unknown method returns schema-valid JSON-RPC error", async () => {
    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([
      {
        jsonrpc: "2.0",
        id: 99,
        method: "resources/list",
      },
    ]);

    await server.connect(transport);
    const error = transport.responseFor(99);
    assertJsonRpcError(error);
    assertMatchesOfficialMcpSchema("JSONRPCMessage", error);
  });

  test("unknown tool returns schema-valid JSON-RPC error", async () => {
    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "schema-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "missing-tool",
          arguments: {},
        },
      },
    ]);

    await server.connect(transport);
    const error = transport.responseFor(2);
    assertJsonRpcError(error);
    assertMatchesOfficialMcpSchema("JSONRPCMessage", error);
  });
});
