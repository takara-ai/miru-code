import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InvokeEndpointCommandOutput } from "@aws-sdk/client-sagemaker-runtime";
import type { EmbeddingClient, EmbeddingPayload, EmbeddingResponse } from "./openai.ts";

type SageMakerRuntimeModule = typeof import("@aws-sdk/client-sagemaker-runtime");
type AwsCredentialProviderModule = typeof import("@aws-sdk/credential-provider-node");
type StaticAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/** Lazily loaded so Takara-only MCP/CLI processes never pay the AWS SDK startup cost. */
let sageMakerRuntimePromise: Promise<SageMakerRuntimeModule> | null = null;
let awsCredentialProviderPromise: Promise<AwsCredentialProviderModule> | null = null;

function loadSageMakerRuntime(): Promise<SageMakerRuntimeModule> {
  sageMakerRuntimePromise ??= import("@aws-sdk/client-sagemaker-runtime");
  return sageMakerRuntimePromise;
}

function loadAwsCredentialProvider(): Promise<AwsCredentialProviderModule> {
  awsCredentialProviderPromise ??= import("@aws-sdk/credential-provider-node");
  return awsCredentialProviderPromise;
}

/** arn:aws:sagemaker:<region>:<account-id>:endpoint/<endpoint-name> (also covers aws-cn/aws-us-gov). */
const ENDPOINT_ARN_PATTERN = /^arn:aws[a-z0-9-]*:sagemaker:([a-z0-9-]+):(\d{12}):endpoint\/(.+)$/;

export interface SageMakerEmbeddingConfig {
  endpointName: string;
  region: string;
  profile?: string;
  normalize: boolean;
  truncate: boolean;
  truncationDirection: "Left" | "Right";
  promptName?: string;
}

export function parseSageMakerEndpointArn(arn: string): {
  region: string;
  accountId: string;
  endpointName: string;
} {
  const match = ENDPOINT_ARN_PATTERN.exec(arn.trim());
  if (!match) {
    throw new Error(
      `Invalid SageMaker endpoint ARN: "${arn}". Expected format ` +
        "arn:aws:sagemaker:<region>:<account-id>:endpoint/<endpoint-name>.",
    );
  }
  const [, region, accountId, endpointName] = match;
  if (!region || !accountId || !endpointName) {
    throw new Error(`Invalid SageMaker endpoint ARN: "${arn}".`);
  }
  return { region, accountId, endpointName };
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return !["false", "0", "no"].includes(raw);
}

function resolveTruncationDirection(): "Left" | "Right" {
  return process.env.MIRU_SAGEMAKER_TRUNCATION_DIRECTION?.trim() === "Left" ? "Left" : "Right";
}

function parseIniProfiles(contents: string): Map<string, Record<string, string>> {
  const profiles = new Map<string, Record<string, string>>();
  let section: Record<string, string> | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = {};
      profiles.set(trimmed.slice(1, -1).trim().toLowerCase(), section);
      continue;
    }
    if (!section) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    section[key] = value;
  }

  return profiles;
}

/**
 * AWS CLI accepts credential-key casing that the AWS SDK's INI parser does not.
 * Keep this fallback deliberately limited to static credentials; SSO, role, and
 * credential_process profiles remain handled by the SDK's normal provider chain.
 */
export function parseCaseInsensitiveStaticCredentials(
  configContents: string,
  credentialsContents: string,
  profileName: string,
): StaticAwsCredentials | null {
  const profile = profileName.trim().toLowerCase();
  if (!profile) {
    return null;
  }

  const merged: Record<string, string> = {};
  for (const [sectionName, values] of parseIniProfiles(configContents)) {
    if (sectionName === profile || sectionName === `profile ${profile}`) {
      Object.assign(merged, values);
    }
  }
  for (const [sectionName, values] of parseIniProfiles(credentialsContents)) {
    if (sectionName === profile) {
      Object.assign(merged, values);
    }
  }

  const accessKeyId = merged.aws_access_key_id;
  const secretAccessKey = merged.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: merged.aws_session_token,
  };
}

function resolveAwsHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function resolveAwsFilePath(variable: string, fallback: string): string {
  const configured = process.env[variable] || fallback;
  return configured.startsWith("~/") ? join(resolveAwsHome(), configured.slice(2)) : configured;
}

async function loadCaseInsensitiveStaticCredentials(
  profileName: string,
): Promise<StaticAwsCredentials | null> {
  const home = resolveAwsHome();
  const configPath = resolveAwsFilePath("AWS_CONFIG_FILE", join(home, ".aws", "config"));
  const credentialsPath = resolveAwsFilePath(
    "AWS_SHARED_CREDENTIALS_FILE",
    join(home, ".aws", "credentials"),
  );

  const [configResult, credentialsResult] = await Promise.allSettled([
    readFile(configPath, "utf8"),
    readFile(credentialsPath, "utf8"),
  ]);
  const configContents = configResult.status === "fulfilled" ? configResult.value : "";
  const credentialsContents =
    credentialsResult.status === "fulfilled" ? credentialsResult.value : "";
  return parseCaseInsensitiveStaticCredentials(configContents, credentialsContents, profileName);
}

/**
 * Reads MIRU_SAGEMAKER_ENDPOINT_ARN (or MIRU_SAGEMAKER_ENDPOINT_NAME + a region) to enable
 * self-hosted mode. AWS credentials are resolved by the SDK's default provider chain
 * (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN, AWS_PROFILE, or an IAM role) —
 * there is nothing Miru-specific to configure for auth.
 */
export function resolveSageMakerConfig(): SageMakerEmbeddingConfig | null {
  const arn = process.env.MIRU_SAGEMAKER_ENDPOINT_ARN?.trim();
  const explicitName = process.env.MIRU_SAGEMAKER_ENDPOINT_NAME?.trim();

  let endpointName: string;
  let region: string;

  if (arn) {
    const parsed = parseSageMakerEndpointArn(arn);
    endpointName = parsed.endpointName;
    region = parsed.region;
  } else if (explicitName) {
    endpointName = explicitName;
    const explicitRegion =
      process.env.MIRU_SAGEMAKER_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim();
    if (!explicitRegion) {
      throw new Error(
        "MIRU_SAGEMAKER_ENDPOINT_NAME is set but no AWS region was found. Set " +
          "MIRU_SAGEMAKER_REGION, AWS_REGION, or AWS_DEFAULT_REGION.",
      );
    }
    region = explicitRegion;
  } else {
    return null;
  }

  return {
    endpointName,
    region,
    profile: process.env.AWS_PROFILE?.trim() || undefined,
    normalize: envBool("MIRU_SAGEMAKER_NORMALIZE", true),
    truncate: envBool("MIRU_SAGEMAKER_TRUNCATE", true),
    truncationDirection: resolveTruncationDirection(),
    promptName: process.env.MIRU_SAGEMAKER_PROMPT_NAME?.trim() || undefined,
  };
}

export function isSageMakerConfigured(): boolean {
  return resolveSageMakerConfig() != null;
}

/** Shown for credential/permission failures — mirrors EMBEDDING_AUTH_ERROR_MESSAGE for the AWS path. */
export const SAGEMAKER_AUTH_ERROR_MESSAGE =
  "Not authorized to invoke this SageMaker endpoint. Check your AWS credentials " +
  "(AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN or AWS_PROFILE) and that the " +
  "identity has sagemaker:InvokeEndpoint permission on the endpoint.";

const AUTH_EXCEPTION_NAMES = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "ExpiredTokenException",
  "CredentialsProviderError",
]);

class SageMakerInvokeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SageMakerInvokeError";
    this.status = status;
  }
}

function toInvokeError(err: unknown): SageMakerInvokeError {
  const awsErr = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    OriginalStatusCode?: string | number;
    OriginalMessage?: string;
  };

  if (awsErr?.name && AUTH_EXCEPTION_NAMES.has(awsErr.name)) {
    return new SageMakerInvokeError(403, SAGEMAKER_AUTH_ERROR_MESSAGE);
  }

  // ModelError wraps the embedding container's real status/message (e.g. 424 when the
  // deployed model isn't an embedding model) behind SageMaker's own 424 response.
  const originalStatus =
    awsErr?.OriginalStatusCode != null ? Number(awsErr.OriginalStatusCode) : undefined;
  const status =
    originalStatus != null && Number.isFinite(originalStatus)
      ? originalStatus
      : (awsErr?.$metadata?.httpStatusCode ?? 500);
  const message = awsErr?.OriginalMessage ?? awsErr?.message ?? String(err);

  if (status === 424) {
    return new SageMakerInvokeError(
      424,
      `SageMaker endpoint returned 424 — the deployed model is not an embedding model (${message}).`,
    );
  }
  return new SageMakerInvokeError(status, `SageMaker endpoint error ${status}: ${message}`);
}

function extractEmbeddings(parsed: unknown): EmbeddingPayload[] {
  if (Array.isArray(parsed)) {
    return parsed as EmbeddingPayload[];
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as {
      embeddings?: EmbeddingPayload[];
      data?: Array<{ embedding: EmbeddingPayload }>;
    };
    if (Array.isArray(obj.embeddings)) {
      return obj.embeddings;
    }
    if (Array.isArray(obj.data)) {
      return obj.data.map((item) => item.embedding);
    }
  }
  throw new Error("SageMaker endpoint returned an unrecognized embedding payload shape");
}

/** Builds the TEI-style /embed request body this schema expects (`inputs`, not `input`). */
function buildRequestBody(
  config: SageMakerEmbeddingConfig,
  input: string[] | string,
  dimensions?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    inputs: input,
    normalize: config.normalize,
    truncate: config.truncate,
    truncation_direction: config.truncationDirection,
  };
  if (dimensions != null) {
    body.dimensions = dimensions;
  }
  if (config.promptName) {
    body.prompt_name = config.promptName;
  }
  return body;
}

export function createSageMakerClient(config: SageMakerEmbeddingConfig): EmbeddingClient {
  let client: InstanceType<SageMakerRuntimeModule["SageMakerRuntimeClient"]> | null = null;

  return {
    async createEmbeddings(
      input: string[] | string,
      _model: string,
      dimensions?: number,
    ): Promise<EmbeddingResponse> {
      const [{ InvokeEndpointCommand, SageMakerRuntimeClient }, { defaultProvider }] =
        await Promise.all([loadSageMakerRuntime(), loadAwsCredentialProvider()]);
      if (!client) {
        const profile = config.profile?.trim() || process.env.AWS_PROFILE?.trim();
        const sdkCredentials = defaultProvider({ profile });
        const credentials = async (): Promise<StaticAwsCredentials> => {
          try {
            return await sdkCredentials();
          } catch (error) {
            const fallback = profile ? await loadCaseInsensitiveStaticCredentials(profile) : null;
            if (fallback) {
              return fallback;
            }
            throw error;
          }
        };
        client = new SageMakerRuntimeClient({ region: config.region, credentials });
      }

      const body = buildRequestBody(config, input, dimensions);

      let response: InvokeEndpointCommandOutput;
      try {
        response = await client.send(
          new InvokeEndpointCommand({
            EndpointName: config.endpointName,
            ContentType: "application/json",
            Accept: "application/json",
            Body: new TextEncoder().encode(JSON.stringify(body)),
          }),
        );
      } catch (err) {
        throw toInvokeError(err);
      }

      if (!response.Body) {
        throw new Error("SageMaker endpoint returned an empty response body");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(response.Body));
      } catch {
        throw new Error("SageMaker endpoint returned invalid JSON");
      }

      const embeddings = extractEmbeddings(parsed);
      return { data: embeddings.map((embedding, index) => ({ index, embedding })) };
    },
  };
}

export interface ValidateSageMakerResult {
  valid: boolean;
  status?: number;
  message: string;
}

/** Real InvokeEndpoint round trip, used by `miru setup --sagemaker` to confirm auth + shape. */
export async function validateSageMakerConnection(
  config: SageMakerEmbeddingConfig,
): Promise<ValidateSageMakerResult> {
  try {
    const client = createSageMakerClient(config);
    const response = await client.createEmbeddings("miru setup validation", "sagemaker-setup");
    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      return { valid: false, message: "SageMaker endpoint returned an empty response." };
    }
    return { valid: true, message: "SageMaker endpoint responded successfully." };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, status, message };
  }
}
