import { divider, fail, hint, info, printBrandBanner, success, writeStdout } from "./cli-ui.ts";
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
  profile?: string;
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
  writeStdout("");
  printBrandBanner(process.stderr);
  divider("─", 48, process.stderr);
  writeStdout("Miru will connect directly to your self-hosted SageMaker embedding endpoint.");
  hint("Miru only inherits AWS credentials from a profile you've already configured —");
  hint("it never creates or writes to ~/.aws. Run `aws configure --profile <name>` first.");
  hint("This replaces any stored Takara API key — only one embedding mode is active at a time.");
  writeStdout("");

  const arnInput = options.sagemakerArn ?? (await promptSageMakerArn());
  const parsed = parseSageMakerEndpointArn(arnInput);

  let profile = options.profile;
  if (!profile) {
    if (!canPromptForCredentials()) {
      throw new Error(
        "An AWS profile name is required. Pass --profile <name>, or run " +
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
  const hadTakaraKey = Boolean((await readStoredCredentials())?.takara_api_key);
  const path = await saveStoredSageMakerCredentials(stored);
  writeStdout("");
  success(`Saved SageMaker config to ${path}`);
  if (hadTakaraKey) {
    hint("Removed the stored Takara API key — Miru now embeds only via SageMaker.");
  } else {
    hint("Miru will embed via this SageMaker endpoint (Takara is not used).");
  }
  writeStdout("");
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
    if (stored?.takara_api_key && !options.apiKey) {
      info(`API key already stored at ${resolveCredentialsPath()}. Use --force to replace.`);
      process.env.TAKARA_API_KEY = stored.takara_api_key;
      return { path: resolveCredentialsPath(), newlySaved: false };
    }
  }

  writeStdout("");
  // stderr banner: setup runs before stdout may be a TTY (e.g. piped miru search).
  printBrandBanner(process.stderr);
  divider("─", 48, process.stderr);
  writeStdout("Miru needs a Takara API key for code embeddings.");
  hint("Get a bearer token from Takara, then enter it below.");
  hint("This replaces any stored SageMaker endpoint — only one embedding mode is active at a time.");
  writeStdout("");

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

  const hadSageMaker = Boolean((await readStoredCredentials())?.sagemaker);
  const path = await saveStoredCredentials(apiKey);
  process.env.TAKARA_API_KEY = apiKey;
  writeStdout("");
  success(`Saved credentials to ${path}`);
  if (hadSageMaker) {
    hint("Removed the stored SageMaker endpoint — Miru now embeds only via Takara.");
  } else {
    hint("MCP loads this key from credentials.json automatically.");
  }
  writeStdout("");
  return { path, newlySaved: true };
}

export async function runClearCredentials(): Promise<void> {
  const { cleared, path } = await clearStoredCredentials();
  if (cleared) {
    success(`Removed stored credentials from ${path}`);
    return;
  }
  info(`No stored credentials at ${path}`);
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
    writeStdout("");
    info("No Takara API key found.");
    hint("Miru needs one for embeddings — enter it below (same as `miru setup`).");
    await runSetup();
    resolveEmbeddingApiKey();
    return;
  }

  writeStdout("");
  // Brand on stderr when credentials are missing in non-interactive mode (stdout may not be a TTY).
  printBrandBanner(process.stderr);
  writeStdout("");

  throw new Error(
    "Takara API key required. Run `miru setup` in a terminal, or set TAKARA_API_KEY " +
      "in your MCP server env (Cursor mcp.json) or .env.local.",
  );
}
