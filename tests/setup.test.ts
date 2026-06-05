import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveStoredCredentials } from "../src/credentials.ts";
import { TAKARA_API_KEY_ENV } from "../src/env.ts";
import { canPromptForCredentials, ensureCredentials, hasCredentials } from "../src/setup.ts";

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

  beforeEach(() => {
    keySnapshot = snapshotKey();
    delete process.env[TAKARA_API_KEY_ENV];
  });

  afterEach(async () => {
    restoreKey(keySnapshot);
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

  test("ensureCredentials throws when non-interactive and key missing", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-empty-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    delete process.env.TAKARA_API_KEY;

    await expect(ensureCredentials({ interactive: false })).rejects.toThrow(
      /Takara API key required/,
    );
  });

  test("canPromptForCredentials reflects stdin TTY", () => {
    expect(typeof canPromptForCredentials()).toBe("boolean");
  });
});
