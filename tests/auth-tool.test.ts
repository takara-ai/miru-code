import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserOpener, registerAuthTool } from "../src/mcp/auth-tool.ts";
import { MiruMcpServer } from "../src/mcp/runtime.ts";
import { fake } from "./helpers/fake-credentials.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

/** A server with only the `auth` tool — no index cache needed for these tests. */
function authServer(
  openBrowser?: BrowserOpener,
  wait?: { waitMs: number; sleep?: (ms: number) => Promise<void> },
): MiruMcpServer {
  const server = new MiruMcpServer({ name: "miru", version: "test" });
  // No waiting by default so start returns immediately; wait tests opt in with a stub sleep.
  registerAuthTool(server, { openBrowser, waitMs: wait?.waitMs ?? 0, sleep: wait?.sleep });
  return server;
}

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
  const prevOpenBrowser = process.env.MIRU_OPEN_BROWSER;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-auth-tool-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    // Keep the real browser from opening during tests that don't inject a stub opener.
    process.env.MIRU_OPEN_BROWSER = "0";
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(credDir, { recursive: true, force: true });
    if (prevDir === undefined) {
      delete process.env.MIRU_CREDENTIALS_DIR;
    } else {
      process.env.MIRU_CREDENTIALS_DIR = prevDir;
    }
    if (prevOpenBrowser === undefined) {
      delete process.env.MIRU_OPEN_BROWSER;
    } else {
      process.env.MIRU_OPEN_BROWSER = prevOpenBrowser;
    }
  });

  test("check with no pending login tells the caller to start one", async () => {
    const server = authServer();
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

    const server = authServer();
    const transport = new MemoryTransport([await callAuthTool(1, { action: "start" })]);
    await server.connect(transport);

    const text = toolTextOf(transport.responseFor(1));
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("https://example.vercel.app/platform/device?user_code=ABCD-1234");
    expect(text).toMatch(/call `auth` again/);
  });

  test("start waits for approval and signs in within a single call", async () => {
    let tokenPolls = 0;
    globalThis.fetch = (async (input, _init) => {
      if (String(input).includes("/oauth/device/code")) {
        return jsonResponse(200, {
          device_code: "device-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.dev.takara.ai/device/approve",
          expires_in: 600,
          interval: 5,
        });
      }
      tokenPolls++;
      return tokenPolls < 3
        ? jsonResponse(400, { error: "authorization_pending" })
        : jsonResponse(200, { access_token: fake("access-token-value"), expires_in: 3600 });
    }) as typeof fetch;

    const sleeps: number[] = [];
    const server = authServer(undefined, {
      waitMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const transport = new MemoryTransport([await callAuthTool(1)]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(1))).toMatch(/Signed in successfully/);
    expect(tokenPolls).toBe(3);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    const raw = JSON.parse(await readFile(join(credDir, "credentials.json"), "utf-8")) as {
      access_token: string;
    };
    expect(raw.access_token).toBe(fake("access-token-value"));
  });

  /** Device-code endpoint plus a scripted sequence of token-endpoint responses. */
  function scriptedFetch(interval: number, tokenReplies: Array<() => Response>): void {
    let next = 0;
    globalThis.fetch = (async (input, _init) => {
      if (String(input).includes("/oauth/device/code")) {
        return jsonResponse(200, {
          device_code: "device-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.dev.takara.ai/device/approve",
          expires_in: 600,
          interval,
        });
      }
      const reply = tokenReplies[Math.min(next++, tokenReplies.length - 1)];
      return (reply as () => Response)();
    }) as typeof fetch;
  }

  test("start backs off by 5s while waiting when the server says slow_down", async () => {
    scriptedFetch(5, [
      () => jsonResponse(400, { error: "slow_down" }),
      () => jsonResponse(200, { access_token: fake("access-token-value"), expires_in: 3600 }),
    ]);

    const sleeps: number[] = [];
    const server = authServer(undefined, {
      waitMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const transport = new MemoryTransport([await callAuthTool(1)]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(1))).toMatch(/Signed in successfully/);
    expect(sleeps).toEqual([5000, 10_000]);
  });

  test("start waits on the real clock by default before polling", async () => {
    // interval 0 is floored to 1s, so this takes one real second and covers the default sleeper.
    scriptedFetch(0, [
      () => jsonResponse(200, { access_token: fake("access-token-value"), expires_in: 3600 }),
    ]);

    const server = authServer(undefined, { waitMs: 1500 });
    const transport = new MemoryTransport([await callAuthTool(1)]);
    const startedAt = Date.now();
    await server.connect(transport);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(toolTextOf(transport.responseFor(1))).toMatch(/Signed in successfully/);
  });

  test("start never polls faster than once a second even if the server advertises interval 0", async () => {
    scriptedFetch(0, [
      () => jsonResponse(200, { access_token: fake("access-token-value"), expires_in: 3600 }),
    ]);

    const sleeps: number[] = [];
    const server = authServer(undefined, {
      waitMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const transport = new MemoryTransport([await callAuthTool(1)]);
    await server.connect(transport);

    expect(sleeps).toEqual([1000]);
  });

  test("start reports a denial that happens during the wait and clears the pending login", async () => {
    scriptedFetch(5, [() => jsonResponse(400, { error: "access_denied" })]);

    const server = authServer(undefined, { waitMs: 60_000, sleep: async () => {} });
    const transport = new MemoryTransport([
      await callAuthTool(1),
      await callAuthTool(2, { action: "check" }),
    ]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(1))).toMatch(/denied/i);
    expect(toolTextOf(transport.responseFor(2))).toMatch(/No device login is pending/);
  });

  test("start keeps the pending login when a poll fails mid-wait, so a repeat call can finish", async () => {
    scriptedFetch(5, [
      () => jsonResponse(400, { error: "server_error", error_description: "boom" }),
      () => jsonResponse(200, { access_token: fake("access-token-value"), expires_in: 3600 }),
    ]);

    const server = authServer(undefined, { waitMs: 60_000, sleep: async () => {} });
    const transport = new MemoryTransport([await callAuthTool(1), await callAuthTool(2)]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(1))).toMatch(/server_error/);
    expect(toolTextOf(transport.responseFor(2))).toMatch(/Signed in successfully/);
  });

  test("start returns still-waiting when the budget runs out, and a repeat call resumes without reopening", async () => {
    process.env.MIRU_OPEN_BROWSER = "1";
    let deviceRequests = 0;
    globalThis.fetch = (async (_input, _init) => {
      deviceRequests++;
      return jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch;

    let opens = 0;
    // waitMs 0: every call runs out of budget immediately, as an unapproved login would.
    const server = authServer(() => {
      opens++;
      return true;
    });
    const transport = new MemoryTransport([await callAuthTool(1), await callAuthTool(2)]);
    await server.connect(transport);

    const first = toolTextOf(transport.responseFor(1));
    expect(first).toMatch(/A browser tab is open/);
    expect(first).toContain("ABCD-1234");
    const second = toolTextOf(transport.responseFor(2));
    expect(second).toMatch(/Still waiting for approval/);
    expect(second).toContain("ABCD-1234");
    expect(deviceRequests).toBe(1);
    expect(opens).toBe(1);
  });

  test("start opens the verification page in the browser and says so", async () => {
    process.env.MIRU_OPEN_BROWSER = "1";
    globalThis.fetch = (async (_input, _init) =>
      jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        verification_uri_complete: "https://example.vercel.app/platform/device?user_code=ABCD-1234",
        expires_in: 600,
        interval: 5,
      })) as typeof fetch;

    const opened: string[] = [];
    const server = authServer((url) => {
      opened.push(url);
      return true;
    });
    const transport = new MemoryTransport([await callAuthTool(1, { action: "start" })]);
    await server.connect(transport);

    expect(opened).toEqual(["https://example.vercel.app/platform/device?user_code=ABCD-1234"]);
    const text = toolTextOf(transport.responseFor(1));
    expect(text).toContain("A browser tab is open");
    expect(text).toContain("ABCD-1234");
  });

  test("start asks the user to open the link when the browser is disabled", async () => {
    process.env.MIRU_OPEN_BROWSER = "0";
    globalThis.fetch = (async (_input, _init) =>
      jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        expires_in: 600,
        interval: 5,
      })) as typeof fetch;

    let called = false;
    const server = authServer(() => {
      called = true;
      return true;
    });
    const transport = new MemoryTransport([await callAuthTool(1, { action: "start" })]);
    await server.connect(transport);

    expect(called).toBe(false);
    const text = toolTextOf(transport.responseFor(1));
    expect(text).toContain("Ask the user to open");
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

    const server = authServer();
    const transport = new MemoryTransport([
      await callAuthTool(1, { action: "start" }),
      await callAuthTool(2, { action: "start" }),
    ]);
    await server.connect(transport);

    expect(calls).toBe(1);
    // The repeat call re-serves the same code instead of burning a new device code.
    expect(toolTextOf(transport.responseFor(2))).toContain("ABCD-1234");
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
        access_token: fake("access-token-value"),
        refresh_token: fake("refresh-token-value"),
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as typeof fetch;

    const server = authServer();
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
    expect(raw.access_token).toBe(fake("access-token-value"));
    expect(raw.refresh_token).toBe(fake("refresh-token-value"));

    delete (globalThis as { __authTestCheckCount?: number }).__authTestCheckCount;
  });

  test("check keeps pending state after a transient error, so a retry can still succeed", async () => {
    let calls = 0;
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
      calls++;
      if (calls === 1) {
        // Unrecognized OAuth error code — checkDeviceAuthorizationOnce throws.
        return jsonResponse(400, { error: "server_error", error_description: "boom" });
      }
      return jsonResponse(200, {
        access_token: fake("access-token-value"),
        expires_in: 3600,
      });
    }) as typeof fetch;

    const server = authServer();
    const transport = new MemoryTransport([
      await callAuthTool(1, { action: "start" }),
      await callAuthTool(2, { action: "check" }),
      await callAuthTool(3, { action: "check" }),
    ]);
    await server.connect(transport);

    expect(toolTextOf(transport.responseFor(2))).toMatch(/server_error/);
    expect(toolTextOf(transport.responseFor(3))).toMatch(/Signed in successfully/);
  });

  test("start re-issues a new login once the previous pending one has expired", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input, _init) => {
      calls++;
      return jsonResponse(200, {
        device_code: `device-${calls}`,
        user_code: `CODE-${calls}`,
        verification_uri: "https://auth.dev.takara.ai/device/approve",
        expires_in: 1,
        interval: 5,
      });
    }) as typeof fetch;

    const server = authServer();
    const first = new MemoryTransport([await callAuthTool(1, { action: "start" })]);
    await server.connect(first);
    expect(calls).toBe(1);
    expect(toolTextOf(first.responseFor(1))).toContain("CODE-1");

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = new MemoryTransport([await callAuthTool(2, { action: "start" })]);
    await server.connect(second);
    expect(calls).toBe(2);
    expect(toolTextOf(second.responseFor(2))).toContain("CODE-2");
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

    const server = authServer();
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
