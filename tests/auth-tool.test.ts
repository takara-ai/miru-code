import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetAuthToolStateForTests } from "../src/mcp/auth-tool.ts";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function callAuthTool(
  id: number,
  args?: { action?: "start" | "check" },
): Promise<{ jsonrpc: "2.0"; id: number; method: "tools/call"; params: unknown }> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "auth", arguments: args ?? {} },
  } as const;
}

function toolTextOf(message: unknown): string {
  const result = (message as { result?: { content?: Array<{ text?: string }> } }).result;
  return result?.content?.[0]?.text ?? "";
}

describe("auth MCP tool", () => {
  let credDir: string;
  const prevDir = process.env.MIRU_CREDENTIALS_DIR;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-auth-tool-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    __resetAuthToolStateForTests();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(credDir, { recursive: true, force: true });
    if (prevDir === undefined) {
      delete process.env.MIRU_CREDENTIALS_DIR;
    } else {
      process.env.MIRU_CREDENTIALS_DIR = prevDir;
    }
    __resetAuthToolStateForTests();
  });

  test("check with no pending login tells the caller to start one", async () => {
    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([await callAuthTool(1, { action: "check" })]);
    await server.connect(transport);

    const text = toolTextOf(transport.responseFor(1));
    expect(text).toMatch(/No device login is pending/);
  });

  test("start returns a verification URL and code", async () => {
    globalThis.fetch = (async (_input, _init) =>
      jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        verification_uri_complete: "https://example.vercel.app/platform/device?user_code=ABCD-1234",
        expires_in: 600,
        interval: 5,
      })) as typeof fetch;

    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([await callAuthTool(1, { action: "start" })]);
    await server.connect(transport);

    const text = toolTextOf(transport.responseFor(1));
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("https://example.vercel.app/platform/device?user_code=ABCD-1234");
    expect(text).toMatch(/action "check"/);
  });

  test("start reuses an existing pending login instead of requesting a new one", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input, _init) => {
      calls++;
      return jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch;

    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([
      await callAuthTool(1, { action: "start" }),
      await callAuthTool(2, { action: "start" }),
    ]);
    await server.connect(transport);

    expect(calls).toBe(1);
    const second = toolTextOf(transport.responseFor(2));
    expect(second).toMatch(/already pending/);
  });

  test("check reports pending, then succeeds and saves device_code credentials", async () => {
    globalThis.fetch = (async (input, _init) => {
      const url = String(input);
      if (url.includes("/oauth/device/code")) {
        return jsonResponse(200, {
          device_code: "device-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.dev.takara.ai/device/approve",
          expires_in: 600,
          interval: 5,
        });
      }
      // First check: still pending. Second check: approved.
      const pendingSoFar =
        (globalThis as { __authTestCheckCount?: number }).__authTestCheckCount ?? 0;
      (globalThis as { __authTestCheckCount?: number }).__authTestCheckCount = pendingSoFar + 1;
      if (pendingSoFar === 0) {
        return jsonResponse(400, { error: "authorization_pending" });
      }
      return jsonResponse(200, {
        access_token: "access-token-value",
        refresh_token: "refresh-token-value",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as typeof fetch;

    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([
      await callAuthTool(1, { action: "start" }),
      await callAuthTool(2, { action: "check" }),
      await callAuthTool(3, { action: "check" }),
    ]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(2))).toMatch(/still waiting/i);
    expect(toolTextOf(transport.responseFor(3))).toMatch(/Signed in successfully/);

    const credPath = join(credDir, "credentials.json");
    const raw = JSON.parse(await readFile(credPath, "utf-8")) as {
      kind: string;
      access_token: string;
      refresh_token: string;
    };
    expect(raw.kind).toBe("device_code");
    expect(raw.access_token).toBe("access-token-value");
    expect(raw.refresh_token).toBe("refresh-token-value");

    delete (globalThis as { __authTestCheckCount?: number }).__authTestCheckCount;
  });

  test("check clears pending state on denial", async () => {
    globalThis.fetch = (async (input, _init) => {
      const url = String(input);
      if (url.includes("/oauth/device/code")) {
        return jsonResponse(200, {
          device_code: "device-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.dev.takara.ai/device/approve",
          expires_in: 600,
          interval: 5,
        });
      }
      return jsonResponse(400, { error: "access_denied" });
    }) as typeof fetch;

    const server = createMcpServer(new IndexCache());
    const transport = new MemoryTransport([
      await callAuthTool(1, { action: "start" }),
      await callAuthTool(2, { action: "check" }),
      await callAuthTool(3, { action: "check" }),
    ]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(2))).toMatch(/denied/i);
    expect(toolTextOf(transport.responseFor(3))).toMatch(/No device login is pending/);
  });
});
