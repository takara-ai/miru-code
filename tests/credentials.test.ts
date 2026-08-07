import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_VERSION } from "../src/auth/types.ts";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  resolveCredentialsDir,
  resolveMiruStateDir,
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

function clearSageMakerEnv(): void {
  delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  delete process.env.AWS_PROFILE;
}

describe("credentials", () => {
  let credDir: string;
  const prevDir = process.env.MIRU_CREDENTIALS_DIR;
  let takaraApiKeySnapshot: string | undefined;
  let sageMakerArnSnapshot: string | undefined;
  let awsProfileSnapshot: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    takaraApiKeySnapshot = snapshotTakaraApiKey();
    sageMakerArnSnapshot = process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    awsProfileSnapshot = process.env.AWS_PROFILE;
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
    if (sageMakerArnSnapshot === undefined) {
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    } else {
      process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = sageMakerArnSnapshot;
    }
    if (awsProfileSnapshot === undefined) {
      delete process.env.AWS_PROFILE;
    } else {
      process.env.AWS_PROFILE = awsProfileSnapshot;
    }
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

  test("resolveMiruStateDir matches credentials dir for global Miru files", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    expect(resolveMiruStateDir()).toBe(resolveCredentialsDir());
    expect(resolveMiruStateDir()).toBe(credDir);
  });

  test("loadStoredCredentials sets env when unset", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    clearTakaraApiKey();
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY ?? "").toBe("stored-token");
  });

  test("loadStoredCredentials loads when MCP placeholder env is set", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    process.env.TAKARA_API_KEY = "$" + "{TAKARA_API_KEY}";
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("stored-token");
  });

  test("loadStoredCredentials does not load when TAKARA_API_KEY is set", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    process.env.TAKARA_API_KEY = "env-token";
    const loaded = await loadStoredCredentials();
    expect(loaded).toBe(false);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });

  test("loadStoredCredentials does not override existing env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();

    await saveStoredCredentials("stored-token");
    process.env.TAKARA_API_KEY = "env-token";
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

  test("readStoredCredentials migrates legacy version-1 SageMaker files in memory", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const path = join(credDir, "credentials.json");
    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    await Bun.write(
      path,
      `{\n  "version": 1,\n  "sagemaker": {"endpoint_arn": "${arn}", "profile": "miru"}\n}\n`,
    );
    await chmod(path, 0o600);

    await expect(readStoredCredentials()).resolves.toEqual({
      version: CREDENTIALS_VERSION,
      kind: "sagemaker",
      endpoint_arn: arn,
      profile: "miru",
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

  test("loadStoredCredentials surfaces refresh failures for callers to recover", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    process.env.MIRU_AUTH_BASE_URL = "https://auth.example.test";
    process.env.MIRU_AUTH_CLIENT_ID = "miru-test";
    clearTakaraApiKey();
    await saveStoredCredentials({
      kind: "device_code",
      accessToken: "expired-token",
      refreshToken: "revoked-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    globalThis.fetch = (async (_input, _init) =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
        { status: 400 },
      )) as typeof fetch;

    await expect(loadStoredCredentials()).rejects.toThrow(/Device token refresh failed/);
    expect(process.env.TAKARA_API_KEY).toBeUndefined();
  });

  test("readStoredCredentials returns null for incomplete device credentials", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const path = join(credDir, "credentials.json");
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          version: CREDENTIALS_VERSION,
          kind: "device_code",
          access_token: "",
          refresh_token: "orphan-refresh",
        },
        null,
        2,
      )}\n`,
    );
    await chmod(path, 0o600);
    expect(await readStoredCredentials()).toBeNull();
  });

  test("clearStoredCredentials removes incomplete device credential files", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    const path = join(credDir, "credentials.json");
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          version: CREDENTIALS_VERSION,
          kind: "device_code",
          access_token: "   ",
          refresh_token: "orphan-refresh",
        },
        null,
        2,
      )}\n`,
    );
    await chmod(path, 0o600);

    const result = await clearStoredCredentials();
    expect(result.cleared).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
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

    await saveStoredCredentials("stored-token");
    process.env.TAKARA_API_KEY = "env-token";
    const result = await clearStoredCredentials();
    expect(result.cleared).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBe("env-token");
  });

  test("saving either mode clears the other from file and env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    clearSageMakerEnv();

    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";

    await saveStoredCredentials("takara-token");
    process.env.TAKARA_API_KEY = "env-only-token";
    await saveStoredCredentials({ kind: "sagemaker", endpointArn: arn, profile: "miru" });

    const stored = await readStoredCredentials();
    expect(stored?.kind).toBe("sagemaker");
    expect(stored).toMatchObject({ kind: "sagemaker", endpoint_arn: arn, profile: "miru" });
    expect(process.env.TAKARA_API_KEY).toBeUndefined();
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBe(arn);
  });

  test("saving Takara credentials removes stored SageMaker endpoint", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    clearSageMakerEnv();

    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    await saveStoredCredentials({ kind: "sagemaker", endpointArn: arn, profile: "miru" });
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arn;
    process.env.AWS_PROFILE = "miru";
    await saveStoredCredentials("takara-token");
    const stored = await readStoredCredentials();
    expect(stored?.kind).toBe("api_key");
    expect(stored).toMatchObject({ kind: "api_key", api_key: "takara-token" });
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBeUndefined();
    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(process.env.TAKARA_API_KEY).toBe("takara-token");
  });

  test("loadStoredCredentials follows credentials.json and drops the other mode from env", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-cred-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    clearTakaraApiKey();
    clearSageMakerEnv();

    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    await saveStoredCredentials({ kind: "sagemaker", endpointArn: arn, profile: "miru" });
    process.env.TAKARA_API_KEY = "stale-takara";

    expect(await loadStoredCredentials()).toBe(true);
    expect(process.env.TAKARA_API_KEY).toBeUndefined();
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBe(arn);

    await saveStoredCredentials("takara-token");
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arn;

    expect(await loadStoredCredentials()).toBe(true);
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBeUndefined();
    expect(process.env.TAKARA_API_KEY).toBe("takara-token");
  });
});
