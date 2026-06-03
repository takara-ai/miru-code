import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  saveStoredCredentials,
} from "../src/credentials.ts";

describe("credentials", () => {
  let credDir: string;
  const prevDir = process.env.MIRU_CREDENTIALS_DIR;
  const prevKey = process.env.TAKARA_API_KEY;

  afterEach(async () => {
    if (credDir) {
      await rm(credDir, { recursive: true, force: true });
    }
    if (prevDir === undefined) {
      delete process.env.MIRU_CREDENTIALS_DIR;
    } else {
      process.env.MIRU_CREDENTIALS_DIR = prevDir;
    }
    if (prevKey === undefined) {
      delete process.env.TAKARA_API_KEY;
    } else {
      process.env.TAKARA_API_KEY = prevKey;
    }
  });

  test("saveStoredCredentials writes versioned file with restricted mode", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    delete process.env.TAKARA_API_KEY;

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
    delete process.env.TAKARA_API_KEY;

    await saveStoredCredentials("stored-token");
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY ?? "").toBe("stored-token");
  });

  test("loadStoredCredentials does not override existing env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
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
    delete process.env.TAKARA_API_KEY;

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
    process.env.TAKARA_API_KEY = "env-token";

    await saveStoredCredentials("stored-token");
    const result = await clearStoredCredentials();
    expect(result.cleared).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });
});
