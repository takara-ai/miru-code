import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  beforeEach(() => {
    takaraApiKeySnapshot = snapshotTakaraApiKey();
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
    restoreTakaraApiKey(takaraApiKeySnapshot);
  });

  test("saveStoredCredentials writes versioned file with restricted mode", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    const path = await saveStoredCredentials("secret-token");
    const raw = JSON.parse(await readFile(path, "utf-8")) as {
      version: number;
      takara_api_key: string;
    };
    expect(raw.version).toBe(1);
    expect(raw.takara_api_key).toBe("secret-token");

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
