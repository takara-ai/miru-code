import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_VERSION } from "../src/auth/types.ts";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  saveStoredCredentials,
} from "../src/credentials.ts";
import { TAKARA_API_KEY_ENV } from "../src/env.ts";

function snapshotTakaraApiKey(): string | undefined {
  return process.env[TAKARA_API_KEY_ENV];
}

function restoreTakaraApiKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[TAKARA_API_KEY_ENV];
  } else {
    process.env[TAKARA_API_KEY_ENV] = value;
  }
}

function clearTakaraApiKey(): void {
  delete process.env[TAKARA_API_KEY_ENV];
}

describe("credentials", () => {
  let credDir: string;
  const prevDir = process.env.MIRU_CREDENTIALS_DIR;
  let takaraApiKeySnapshot: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    takaraApiKeySnapshot = snapshotTakaraApiKey();
    delete process.env.MIRU_AUTH_BASE_URL;
    delete process.env.MIRU_AUTH_CLIENT_ID;
  });

  afterEach(async () => {
    if (credDir) {
      await rm(credDir, { recursive: true, force: true });
    }
    if (prevDir === undefined) {
      delete process.env.MIRU_CREDENTIALS_DIR;
    } else {
      process.env.MIRU_CREDENTIALS_DIR = prevDir;
    }
    globalThis.fetch = originalFetch;
    restoreTakaraApiKey(takaraApiKeySnapshot);
  });

  test("saveStoredCredentials writes versioned file with restricted mode", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    const path = await saveStoredCredentials("secret-token");
    const raw = JSON.parse(await readFile(path, "utf-8")) as {
      version: number;
      kind: string;
      api_key: string;
    };
    expect(raw.version).toBe(CREDENTIALS_VERSION);
    expect(raw.kind).toBe("api_key");
    expect(raw.api_key).toBe("secret-token");

    const fileStat = await stat(path);
    if (process.platform !== "win32") {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  test("loadStoredCredentials sets env when unset", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY ?? "").toBe("stored-token");
  });

  test("loadStoredCredentials loads when MCP placeholder env is set", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    process.env.TAKARA_API_KEY = "$" + "{TAKARA_API_KEY}";

    await saveStoredCredentials("stored-token");
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("stored-token");
  });

  test("loadStoredCredentials does not load when TAKARA_API_KEY is set", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    process.env.TAKARA_API_KEY = "env-token";

    await saveStoredCredentials("stored-token");
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(false);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });

  test("loadStoredCredentials does not override existing env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    process.env.TAKARA_API_KEY = "env-token";

    await saveStoredCredentials("stored-token");
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(false);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });

  test("readStoredCredentials returns null for invalid file", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const path = join(credDir, "credentials.json");
    await Bun.write(path, '{"version": 99}\n');
    await chmod(path, 0o600);
    expect(await readStoredCredentials()).toBeNull();
  });

  test("readStoredCredentials migrates legacy version-1 API-key files in memory", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const path = join(credDir, "credentials.json");
    await Bun.write(path, '{\n  "version": 1,\n  "takara_api_key": "legacy-token"\n}\n');
    await chmod(path, 0o600);

    await expect(readStoredCredentials()).resolves.toEqual({
      version: CREDENTIALS_VERSION,
      kind: "api_key",
      api_key: "legacy-token",
    });
  });

  test("loadStoredCredentials refreshes expired device credentials", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.MIRU_AUTH_BASE_URL = "https://auth.example.test";
    process.env.MIRU_AUTH_CLIENT_ID = "miru-test";
    clearTakaraApiKey();
    await saveStoredCredentials({
      kind: "device_code",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://auth.example.test/oauth/token");
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("fresh-token");

    const stored = JSON.parse(await readFile(join(credDir, "credentials.json"), "utf-8")) as {
      kind: string;
      access_token: string;
      refresh_token: string;
    };
    expect(stored.kind).toBe("device_code");
    expect(stored.access_token).toBe("fresh-token");
    expect(stored.refresh_token).toBe("fresh-refresh-token");
  });

  test("clearStoredCredentials removes file and unsets loaded env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    await loadStoredCredentials();
    expect(process.env.TAKARA_API_KEY ?? "").toBe("stored-token");

    const result = await clearStoredCredentials();
    expect(result.cleared).toBe(true);
    expect(await Bun.file(result.path).exists()).toBe(false);
    expect(process.env.TAKARA_API_KEY).toBeUndefined();
  });

  test("clearStoredCredentials does not unset unrelated env key", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    process.env.TAKARA_API_KEY = "env-token";

    await saveStoredCredentials("stored-token");
    const result = await clearStoredCredentials();
    expect(result.cleared).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });
});
