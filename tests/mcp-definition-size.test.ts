import { describe, expect, test } from "bun:test";
import type { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { countTokens } from "../src/token-count.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

/**
 * Every tool definition and the server instructions are sent to the model at the start of every
 * session (the tools are loaded upfront via anthropic/alwaysLoad), so their size is a per-session
 * token cost. Keep it bounded, and keep the trimmed schema noise from creeping back.
 */
const DEFINITIONS_TOKEN_BUDGET = 2_500;

type Listed = { name: string; description: string; inputSchema: Record<string, unknown> };

const call = (id: number, name: string, args: object) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

async function listDefinitions(): Promise<{ tools: Listed[]; instructions: string }> {
  const transport = new MemoryTransport([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "size-test", version: "0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ] as never);
  await createMcpServer({ get: async () => ({}) } as unknown as IndexCache).connect(transport);
  const init = transport.responseFor(1) as { result: { instructions: string } };
  const list = transport.responseFor(2) as { result: { tools: Listed[] } };
  return { tools: list.result.tools, instructions: init.result.instructions };
}

describe("MCP definition size", () => {
  test("tool definitions plus server instructions stay within the per-session budget", async () => {
    const { tools, instructions } = await listDefinitions();
    const total = tools.reduce((sum, tool) => sum + countTokens(JSON.stringify(tool)), 0);
    expect(total + countTokens(instructions)).toBeLessThanOrEqual(DEFINITIONS_TOKEN_BUDGET);
  });

  test("the advertised schemas carry no validator-implied bounds", async () => {
    const { tools } = await listDefinitions();
    const wire = JSON.stringify(tools);
    expect(wire).not.toContain("9007199254740991");
    expect(wire).not.toContain('"minLength"');
    expect(wire).not.toContain('"minItems"');
    // Real, meaningful bounds are kept.
    const locate = tools.find((tool) => tool.name === "locate");
    expect(JSON.stringify(locate?.inputSchema)).toContain('"minimum":1');
  });

  test("trimming the advertised schema does not loosen call-time validation", async () => {
    const index = {
      root: null,
      chunks: [],
      locateLiteral: () => ({
        literal: "x",
        mode: "count",
        n: 0,
        files: 0,
        truncated: false,
        hits: [],
      }),
    };
    const transport = new MemoryTransport([
      call(1, "locate", { literal: "" }),
      call(2, "locate", { literal: "x", limit: 0 }),
      call(3, "expand", { file_path: "a.ts", anchor_line: 1.5 }),
    ]);
    await createMcpServer({ get: async () => index } as unknown as IndexCache).connect(transport);
    for (const id of [1, 2, 3]) {
      expect((transport.responseFor(id) as { error?: { code: number } }).error?.code).toBe(-32602);
    }
  });

  test("the compressed definitions keep the behavior-critical guidance", async () => {
    const { tools, instructions } = await listDefinitions();
    const text = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(text("auth")).toContain("never speculatively");
    expect(text("locate")).toContain("regex");
    expect(text("locate")).toContain("include");
    expect(text("locate")).toContain("do NOT fall back to Grep");
    expect(text("search")).toContain("`locate`");
    expect(text("expand")).toContain("truncated: true");
    expect(instructions).toContain("`auth`");
    expect(instructions).toContain("truncated: true");
    expect(instructions).toContain("out-of-scope");
  });
});
