import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStoredCredentials,
  saveStoredCredentials,
  saveStoredSageMakerCredentials,
} from "../src/credentials.ts";
import { TAKARA_API_KEY_ENV } from "../src/env.ts";
import {
  canPromptForCredentials,
  ensureCredentials,
  hasCredentials,
  parseSetupCliArgs,
  runSageMakerSetup,
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
  let sageMakerArnSnapshot: string | undefined;
  let awsProfileSnapshot: string | undefined;

  beforeEach(() => {
    keySnapshot = snapshotKey();
    sageMakerArnSnapshot = process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    awsProfileSnapshot = process.env.AWS_PROFILE;
    delete process.env[TAKARA_API_KEY_ENV];
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    delete process.env.AWS_PROFILE;
  });

  afterEach(async () => {
    restoreKey(keySnapshot);
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
      /Takara API key required/,
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

  test("runSageMakerSetup purges a stored Takara API key", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-sm-purge-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    await saveStoredCredentials("takara-token");
    process.env.TAKARA_API_KEY = "takara-token";

    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    const result = await runSageMakerSetup({
      skipValidation: true,
      sagemakerArn: arn,
      profile: "miru",
    });

    expect(result.newlySaved).toBe(true);
    const stored = await readStoredCredentials();
    expect(stored?.takara_api_key).toBeUndefined();
    expect(stored?.sagemaker).toEqual({ endpoint_arn: arn, profile: "miru" });
    expect(process.env.TAKARA_API_KEY).toBeUndefined();
    // Cast: delete/assign on process.env narrows the property under Bun's Env types.
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN as string | undefined).toBe(arn);
  });

  test("runSetup purges a stored SageMaker endpoint", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-tk-purge-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    await saveStoredSageMakerCredentials({ endpoint_arn: arn, profile: "miru" });
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arn;
    process.env.AWS_PROFILE = "miru";
    delete process.env.TAKARA_API_KEY;

    const result = await runSetup({
      skipValidation: true,
      apiKey: "new-takara-token",
      force: true,
    });

    expect(result.newlySaved).toBe(true);
    const stored = await readStoredCredentials();
    expect(stored?.sagemaker).toBeUndefined();
    expect(stored?.takara_api_key).toBe("new-takara-token");
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBeUndefined();
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  test("runSetup migrates to Takara when env key is set and SageMaker is still stored", async () => {
    credDir = await mkdtemp(join(tmpdir(), "miru-setup-migrate-"));
    process.env.MIRU_CREDENTIALS_DIR = credDir;
    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    await saveStoredSageMakerCredentials({ endpoint_arn: arn, profile: "miru" });
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arn;
    process.env.AWS_PROFILE = "miru";
    process.env.TAKARA_API_KEY = "env-takara-token";

    const result = await runSetup({ skipValidation: true });

    expect(result.newlySaved).toBe(true);
    const stored = await readStoredCredentials();
    expect(stored?.sagemaker).toBeUndefined();
    expect(stored?.takara_api_key).toBe("env-takara-token");
    expect(process.env.MIRU_SAGEMAKER_ENDPOINT_ARN).toBeUndefined();
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  test("hasCredentials is true when SageMaker endpoint ARN is configured", () => {
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN =
      "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    expect(hasCredentials()).toBe(true);
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  });
});

describe("parseSetupCliArgs", () => {
  test("parses Takara --key / -k and --force", () => {
    expect(parseSetupCliArgs(["--key", "tok", "--force"]).args).toEqual({
      apiKey: "tok",
      force: true,
      clear: false,
      sagemaker: false,
      sagemakerArn: undefined,
      profile: undefined,
    });
    expect(parseSetupCliArgs(["-k", "tok"]).args.apiKey).toBe("tok");
  });

  test("parses SageMaker flags and implies sagemaker from --arn", () => {
    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    expect(parseSetupCliArgs(["--sagemaker", "--arn", arn, "--profile", "miru"]).args).toEqual({
      apiKey: undefined,
      force: false,
      clear: false,
      sagemaker: true,
      sagemakerArn: arn,
      profile: "miru",
    });
    expect(parseSetupCliArgs(["--arn", arn]).args).toMatchObject({
      sagemaker: true,
      sagemakerArn: arn,
    });
  });

  test("rejects combining --sagemaker with --key", () => {
    const result = parseSetupCliArgs(["--sagemaker", "--key", "tok"]);
    expect(result.error).toBe("sagemaker_with_key");
    expect(result.args.sagemaker).toBe(true);
    expect(result.args.apiKey).toBe("tok");
  });

  test("rejects combining --arn with --key", () => {
    const arn = "arn:aws:sagemaker:us-east-1:123456789012:endpoint/miru-test";
    expect(parseSetupCliArgs(["--arn", arn, "--key", "tok"]).error).toBe("sagemaker_with_key");
  });

  test("rejects combining --clear with --key", () => {
    expect(parseSetupCliArgs(["--clear", "--key", "tok"]).error).toBe("clear_with_key");
  });

  test("parses --clear alone", () => {
    expect(parseSetupCliArgs(["--clear"]).args).toEqual({
      apiKey: undefined,
      force: false,
      clear: true,
      sagemaker: false,
      sagemakerArn: undefined,
      profile: undefined,
    });
  });
});
