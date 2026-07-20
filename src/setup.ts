import { divider, fail, hint, info, printBrandBanner, success, writeStderr } from "./cli-ui.ts";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  resolveCredentialsPath,
  type StoredSageMakerCredentials,
  saveStoredCredentials,
  saveStoredSageMakerCredentials,
} from "./credentials.ts";
import {
  isSageMakerConfigured,
  parseSageMakerEndpointArn,
  type SageMakerEmbeddingConfig,
  validateSageMakerConnection,
} from "./embeddings/sagemaker.ts";
import { validateEmbeddingApiKey } from "./embeddings/validate.ts";
import { hasTakaraApiKeyInEnv, resolveEmbeddingApiKey } from "./env.ts";
import { promptHidden, promptText } from "./prompt.ts";
import { Spinner } from "./spinner.ts";

async function promptApiKey(): Promise<string> {
  let key = "";
  while (!key) {
    key = await promptHidden("Takara API key (input hidden): ");
    if (!key) {
      fail("API key cannot be empty.");
    }
  }
  return key;
}

export interface RunSetupOptions {
  apiKey?: string;
  force?: boolean;
  skipValidation?: boolean;
  sagemaker?: boolean;
  sagemakerArn?: string;
  awsProfile?: string;
}

export interface RunSetupResult {
  path: string;
  newlySaved: boolean;
}

async function promptSageMakerArn(): Promise<string> {
  while (true) {
    const arn = await promptText("SageMaker endpoint ARN");
    if (!arn) {
      fail("Endpoint ARN cannot be empty.");
      continue;
    }
    try {
      parseSageMakerEndpointArn(arn);
      return arn;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}

async function promptAwsProfile(): Promise<string> {
  while (true) {
    const profile = await promptText(
      "AWS profile name (must already exist in ~/.aws)",
      process.env.AWS_PROFILE || "miru",
    );
    if (profile) {
      return profile;
    }
    fail("AWS profile name cannot be empty.");
  }
}

/**
 * Miru only ever inherits AWS credentials — it never creates, writes, or rotates an
 * AWS profile. Set one up yourself first (e.g. `aws configure --profile miru`).
 */
export async function runSageMakerSetup(options: RunSetupOptions = {}): Promise<RunSetupResult> {
  writeStderr("");
  printBrandBanner(process.stderr);
  divider("─", 48, process.stderr);
  writeStderr("Miru will connect directly to your self-hosted SageMaker embedding endpoint.");
  hint("Miru only inherits AWS credentials from a profile you've already configured —");
  hint("it never creates or writes to ~/.aws. Run `aws configure --profile <name>` first.");
  writeStderr("");

  const arnInput = options.sagemakerArn ?? (await promptSageMakerArn());
  const parsed = parseSageMakerEndpointArn(arnInput);

  let profile = options.awsProfile;
  if (!profile) {
    if (!canPromptForCredentials()) {
      throw new Error(
        "An AWS profile name is required. Pass --aws-profile <name>, or run " +
          "`miru setup --sagemaker` interactively.",
      );
    }
    profile = await promptAwsProfile();
  }

  process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arnInput;
  process.env.AWS_PROFILE = profile;

  if (!options.skipValidation) {
    const spinner = new Spinner(`Validating SageMaker endpoint (profile "${profile}")`);
    spinner.start();
    const config: SageMakerEmbeddingConfig = {
      endpointName: parsed.endpointName,
      region: parsed.region,
      normalize: true,
      truncate: true,
      truncationDirection: "Right",
    };
    const result = await validateSageMakerConnection(config);
    if (!result.valid) {
      spinner.stop();
      throw new Error(result.message);
    }
    spinner.succeed("SageMaker endpoint validated");
  }

  const stored: StoredSageMakerCredentials = { endpoint_arn: arnInput, profile };
  const path = await saveStoredSageMakerCredentials(stored);
  writeStderr("");
  success(`Saved SageMaker config to ${path}`);
  hint("Miru will use this endpoint instead of Takara from now on.");
  writeStderr("");
  return { path, newlySaved: true };
}

export async function runSetup(options: RunSetupOptions = {}): Promise<RunSetupResult> {
  if (options.sagemaker || options.sagemakerArn) {
    return runSageMakerSetup(options);
  }

  if (!options.force && hasTakaraApiKeyInEnv()) {
    const path = resolveCredentialsPath();
    const stored = await readStoredCredentials();
    if (stored) {
      info(`API key already configured (env + ${path}). Use --force to replace stored key.`);
      return { path, newlySaved: false };
    }
    info("API key already set via environment variable. Stored credentials unchanged.");
    return { path: resolveCredentialsPath(), newlySaved: false };
  }

  if (!options.force) {
    const stored = await readStoredCredentials();
    if (stored && !options.apiKey) {
      info(`API key already stored at ${resolveCredentialsPath()}. Use --force to replace.`);
      process.env.TAKARA_API_KEY = stored.takara_api_key;
      return { path: resolveCredentialsPath(), newlySaved: false };
    }
  }

  writeStderr("");
  // stderr banner: setup runs before stdout may be a TTY (e.g. piped miru search).
  printBrandBanner(process.stderr);
  divider("─", 48, process.stderr);
  writeStderr("Miru needs a Takara API key for code embeddings.");
  hint("Get a bearer token from Takara, then enter it below.");
  writeStderr("");

  const apiKey = options.apiKey ?? (await promptApiKey());

  if (!options.skipValidation) {
    const spinner = new Spinner("Validating API key");
    spinner.start();
    const result = await validateEmbeddingApiKey({ apiKey });
    if (!result.valid) {
      spinner.stop();
      throw new Error(result.message);
    }
    spinner.succeed("API key validated");
  }

  const path = await saveStoredCredentials(apiKey);
  process.env.TAKARA_API_KEY = apiKey;
  writeStderr("");
  success(`Saved credentials to ${path}`);
  hint("MCP loads this key from credentials.json automatically.");
  writeStderr("");
  return { path, newlySaved: true };
}

export async function runClearCredentials(): Promise<void> {
  const { cleared, path } = await clearStoredCredentials();
  if (cleared) {
    success(`Removed stored API key from ${path}`);
    return;
  }
  info(`No stored API key at ${path}`);
}

export function canPromptForCredentials(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function hasCredentials(): boolean {
  if (isSageMakerConfigured()) {
    return true;
  }
  try {
    resolveEmbeddingApiKey();
    return true;
  } catch {
    return false;
  }
}

async function refreshCredentialsFromStore(): Promise<void> {
  await loadStoredCredentials();
}

export async function ensureCredentials(options?: { interactive?: boolean }): Promise<void> {
  if (hasCredentials()) {
    return;
  }

  await refreshCredentialsFromStore();
  if (hasCredentials()) {
    return;
  }

  const wantsPrompt = options?.interactive ?? true;
  if (wantsPrompt && canPromptForCredentials()) {
    writeStderr("");
    info("No Takara API key found.");
    hint("Miru needs one for embeddings — enter it below (same as `miru setup`).");
    await runSetup();
    resolveEmbeddingApiKey();
    return;
  }

  writeStderr("");
  // Brand on stderr when credentials are missing in non-interactive mode (stdout may not be a TTY).
  printBrandBanner(process.stderr);
  writeStderr("");

  throw new Error(
    "Takara API key required. Run `miru setup` in a terminal, or set TAKARA_API_KEY " +
      "in your MCP server env (Cursor mcp.json) or .env.local.",
  );
}
