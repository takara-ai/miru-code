import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStoredCredentials, saveStoredCredentials } from "../src/credentials.ts";
import { TAKARA_API_KEY_ENV } from "../src/env.ts";
import {
  canPromptForCredentials,
  ensureCredentials,
  hasCredentials,
  runSetup,
} from "../src/setup.ts";

function snapshotKey(): string | undefined {
  return process.env[TAKARA_API_KEY_ENV];
}

function restoreKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[TAKARA_API_KEY_ENV];
  } else {
    process.env[TAKARA_API_KEY_ENV] = value;
  }
}

describe("setup credentials", () => {
  let credDir = "";
  let keySnapshot: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    keySnapshot = snapshotKey();
    delete process.env[TAKARA_API_KEY_ENV];
    delete process.env.MIRU_AUTH_BASE_URL;
    delete process.env.MIRU_AUTH_CLIENT_ID;
  });

  afterEach(async () => {
    restoreKey(keySnapshot);
    globalThis.fetch = originalFetch;
    if (credDir) {
      await rm(credDir, { recursive: true, force: true });
      credDir = "";
    }
    delete process.env.MIRU_CREDENTIALS_DIR;
  });

  test("hasCredentials is false without env or stored file", () => {
    expect(hasCredentials()).toBe(false);
  });

  test("hasCredentials is true when TAKARA_API_KEY is set", () => {
    process.env.TAKARA_API_KEY = "token";
    expect(hasCredentials()).toBe(true);
  });

  test("hasCredentials is true after loadStoredCredentials", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    await saveStoredCredentials("stored-token");
    delete process.env.TAKARA_API_KEY;

    const { loadStoredCredentials } = await import("../src/credentials.ts");
    await loadStoredCredentials();
    expect(hasCredentials()).toBe(true);
  });

  test("ensureCredentials loads stored key when MCP placeholder env is set", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-mcp-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.TAKARA_API_KEY = "$" + "{TAKARA_API_KEY}";
    await saveStoredCredentials("stored-token");

    await ensureCredentials({ interactive: false });
    expect(process.env.TAKARA_API_KEY).toBe("stored-token");
  });

  test("ensureCredentials throws when non-interactive and key missing", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-empty-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    delete process.env.TAKARA_API_KEY;

    await expect(ensureCredentials({ interactive: false })).rejects.toThrow(
      /Initial login must be completed in an interactive terminal/,
    );
  });

  test("canPromptForCredentials reflects stdin TTY", () => {
    expect(typeof canPromptForCredentials()).toBe("boolean");
  });

  test("runSetup returns newlySaved false when credentials already stored", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-existing-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    await saveStoredCredentials("stored-token");

    const result = await runSetup({ skipValidation: true });
    expect(result.newlySaved).toBe(false);
    expect(result.path).toContain("credentials.json");
  });

  test("runSetup accepts explicit key entry with validation disabled", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-explicit-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;

    const result = await runSetup({ apiKey: "explicit-token", skipValidation: true, force: true });
    expect(result.newlySaved).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("explicit-token");
  });

  test("ensureCredentials can bootstrap device login without a TTY-style prompt path", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-device-bootstrap-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.MIRU_AUTH_BASE_URL = "https://auth.example.test";
    process.env.MIRU_AUTH_CLIENT_ID = "miru-test";

    let call = 0;
    globalThis.fetch = (async (input) => {
      call++;
      if (call === 1) {
        expect(String(input)).toBe("https://auth.example.test/oauth/device/code");
        return new Response(
          JSON.stringify({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://verify.example.test",
            expires_in: 600,
            interval: 0,
          }),
          { status: 200 },
        );
      }
      expect(String(input)).toBe("https://auth.example.test/oauth/token");
      return new Response(
        JSON.stringify({
          access_token: "device-access-token",
          refresh_token: "device-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await ensureCredentials({ interactive: true });
    expect(process.env.TAKARA_API_KEY).toBe("device-access-token");
  });

  test("ensureCredentials falls back to re-auth when refresh fails and interactive login is allowed", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-refresh-fallback-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.MIRU_AUTH_BASE_URL = "https://auth.example.test";
    process.env.MIRU_AUTH_CLIENT_ID = "miru-test";
    await saveStoredCredentials({
      kind: "device_code",
      accessToken: "stale-token",
      refreshToken: "revoked-refresh-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    let call = 0;
    globalThis.fetch = (async (input, init) => {
      call++;
      if (call === 1) {
        expect(String(input)).toBe("https://auth.example.test/oauth/token");
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "refresh token revoked",
          }),
          { status: 400 },
        );
      }
      if (call === 2) {
        expect(String(input)).toBe("https://auth.example.test/oauth/device/code");
        return new Response(
          JSON.stringify({
            device_code: "new-device-code",
            user_code: "ZXCV-BNMQ",
            verification_uri: "https://verify.example.test",
            expires_in: 600,
            interval: 0,
          }),
          { status: 200 },
        );
      }
      expect(String(input)).toBe("https://auth.example.test/oauth/token");
      expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
      return new Response(
        JSON.stringify({
          access_token: "reauth-token",
          refresh_token: "reauth-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await ensureCredentials({ interactive: true });
    expect(process.env.TAKARA_API_KEY).toBe("reauth-token");
  });

  test("runSetup marks saved device tokens as store-managed for later refresh in long-lived processes", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-managed-device-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.MIRU_AUTH_BASE_URL = "https://auth.example.test";
    process.env.MIRU_AUTH_CLIENT_ID = "miru-test";

    let call = 0;
    globalThis.fetch = (async (input, init) => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            device_code: "setup-device-code",
            user_code: "QWER-TYUI",
            verification_uri: "https://verify.example.test",
            expires_in: 600,
            interval: 0,
          }),
          { status: 200 },
        );
      }
      if (call === 2) {
        return new Response(
          JSON.stringify({
            access_token: "initial-device-token",
            refresh_token: "initial-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }
      expect(String(input)).toBe("https://auth.example.test/oauth/token");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return new Response(
        JSON.stringify({
          access_token: "refreshed-device-token",
          refresh_token: "refreshed-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await runSetup({ device: true, force: true, interactive: true });
    expect(process.env.TAKARA_API_KEY).toBe("initial-device-token");

    await saveStoredCredentials({
      kind: "device_code",
      accessToken: "initial-device-token",
      refreshToken: "initial-refresh-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("refreshed-device-token");

    const stored = JSON.parse(await readFile(join(credDir, "credentials.json"), "utf-8")) as {
      access_token: string;
      refresh_token: string;
    };
    expect(stored.access_token).toBe("refreshed-device-token");
    expect(stored.refresh_token).toBe("refreshed-refresh-token");
  });
});
