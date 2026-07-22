#!/usr/bin/env bun
/**
 * Admin runbook: create a least-privilege IAM user that can only InvokeEndpoint on one
 * SageMaker endpoint, then install a named AWS profile with the access keys.
 *
 * This is NOT part of `miru setup`. Miru only inherits credentials — it never creates
 * IAM users or writes ~/.aws. Run this (or equivalent IdP/SSO role setup) once as an
 * account admin, then point Miru at the profile.
 *
 * Requires: AWS CLI, and caller credentials with iam:CreateUser / PutUserPolicy /
 * CreateAccessKey (typically an admin role).
 *
 * Usage:
 *   bun run scripts/create-sagemaker-invoke-user.ts \
 *     --endpoint-arn arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-endpoint \
 *     --profile miru
 *
 * See docs/self-hosted-sagemaker.md
 */
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSageMakerEndpointArn } from "../src/embeddings/sagemaker.ts";

type Args = {
  endpointArn: string;
  profile: string;
  userName?: string;
};

function getArg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) {
    return undefined;
  }
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    return undefined;
  }
  return v;
}

function usageError(message: string): never {
  console.error(`Error: ${message}`);
  console.error("");
  console.error(
    "Usage: bun run scripts/create-sagemaker-invoke-user.ts --endpoint-arn <arn> [--profile miru] [--user-name <name>]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const endpointArn = getArg(argv, "--endpoint-arn") ?? getArg(argv, "--arn");
  if (!endpointArn) {
    usageError("--endpoint-arn is required");
  }
  return {
    endpointArn,
    profile: getArg(argv, "--profile") ?? "miru",
    userName: getArg(argv, "--user-name"),
  };
}

async function runAws(args: string[]): Promise<string> {
  const proc = Bun.spawn(["aws", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`aws ${args.join(" ")} failed:\n${stderr || stdout}`);
  }
  return stdout.trim();
}

async function ensureUser(userName: string, endpointName: string): Promise<void> {
  try {
    await runAws([
      "iam",
      "create-user",
      "--user-name",
      userName,
      "--tags",
      "Key=Purpose,Value=SageMakerInvokeOnly",
      `Key=Endpoint,Value=${endpointName}`,
      "Key=ManagedBy,Value=miru-create-sagemaker-invoke-user",
    ]);
    console.log(`Created IAM user: ${userName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/EntityAlreadyExists|already exists/i.test(message)) {
      throw error;
    }
    console.log(`Using existing IAM user: ${userName}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { region, endpointName } = parseSageMakerEndpointArn(args.endpointArn);
  const userName =
    args.userName ??
    `miru-invoke-${endpointName}`.replace(/[^a-zA-Z0-9+=,.@_-]/g, "-").slice(0, 64);

  console.log("Creating invoke-only IAM user + AWS profile for Miru.");
  console.log(`Endpoint: ${args.endpointArn}`);
  console.log(`Profile:  ${args.profile}`);
  console.log("");

  await ensureUser(userName, endpointName);

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "InvokeOnlyThisEndpoint",
        Effect: "Allow",
        Action: ["sagemaker:InvokeEndpoint"],
        Resource: args.endpointArn,
      },
    ],
  };

  const policyPath = join(tmpdir(), `${userName}-policy.json`);
  await Bun.write(policyPath, JSON.stringify(policy));
  try {
    await runAws([
      "iam",
      "put-user-policy",
      "--user-name",
      userName,
      "--policy-name",
      "sagemaker-invoke-only-this-endpoint",
      "--policy-document",
      `file://${policyPath}`,
    ]);
  } finally {
    await unlink(policyPath).catch(() => undefined);
  }
  console.log(`Attached invoke-only policy for ${args.endpointArn}`);

  const keyRaw = await runAws([
    "iam",
    "create-access-key",
    "--user-name",
    userName,
    "--output",
    "json",
  ]);
  const key = JSON.parse(keyRaw) as {
    AccessKey: { AccessKeyId: string; SecretAccessKey: string };
  };
  const { AccessKeyId, SecretAccessKey } = key.AccessKey;

  await runAws(["configure", "set", "aws_access_key_id", AccessKeyId, "--profile", args.profile]);
  await runAws([
    "configure",
    "set",
    "aws_secret_access_key",
    SecretAccessKey,
    "--profile",
    args.profile,
  ]);
  await runAws(["configure", "set", "region", region, "--profile", args.profile]);

  console.log("");
  console.log(`Installed AWS profile: ${args.profile}`);
  console.log(`IAM user: ${userName}`);
  console.log("");
  console.log("Next — point Miru at the endpoint (purges any stored Takara API key):");
  console.log(
    `  miru setup --sagemaker --arn ${args.endpointArn} --profile ${args.profile}`,
  );
  console.log("");
  console.log("Optional smoke test:");
  console.log(`  bun run sagemaker:auth-check -- --arn ${args.endpointArn}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
