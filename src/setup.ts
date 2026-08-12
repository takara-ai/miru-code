import { authenticateWithProvider } from "./auth/providers.ts";
import { credentialAccessToken } from "./auth/types.ts";
import {
  divider,
  fail,
  hint,
  info,
  printBrandBanner,
  success,
  writeStderr,
  writeStdout,
} from "./cli-ui.ts";
import {
  beginModeSwitch,
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  resolveCredentialsPath,
  saveStoredCredentials,
  setStoredCredentialsEnvToken,
} from "./credentials.ts";
import {
  isSageMakerConfigured,
  parseSageMakerEndpointArn,
  type SageMakerEmbeddingConfig,
  validateSageMakerConnection,
} from "./embeddings/sagemaker.ts";
import { hasTakaraApiKeyInEnv, resolveEmbeddingApiKey } from "./env.ts";
import { promptText } from "./prompt.ts";
import { Spinner } from "./spinner.ts";

export interface RunSetupOptions {
  apiKey?: string;
  device?: boolean;
  force?: boolean;
  skipValidation?: boolean;
  sagemaker?: boolean;
  sagemakerArn?: string;
  profile?: string;
  allowManualFallback?: boolean;
  interactive?: boolean;
}

export interface RunSetupResult {
  path: string;
  newlySaved: boolean;
}

export interface ParsedSetupCliArgs {
  apiKey?: string;
  device: boolean;
  force: boolean;
  clear: boolean;
  sagemaker: boolean;
  sagemakerArn?: string;
  profile?: string;
}

export type SetupCliArgError =
  | "clear_with_key"
  | "sagemaker_with_key"
  | "device_with_key"
  | "device_with_sagemaker";

/** Parse `miru setup` argv (everything after the `setup` command). */
export function parseSetupCliArgs(rest: string[]): {
  args: ParsedSetupCliArgs;
  error?: SetupCliArgError;
} {
  let apiKey: string | undefined;
  let device = false;
  let force = false;
  let clear = false;
  let sagemaker = false;
  let sagemakerArn: string | undefined;
  let profile: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--clear") {
      clear = true;
    } else if (arg === "--device") {
      device = true;
    } else if ((arg === "--key" || arg === "-k") && rest[i + 1]) {
      apiKey = rest[++i];
    } else if (arg === "--sagemaker") {
      sagemaker = true;
    } else if (arg === "--arn" && rest[i + 1]) {
      sagemakerArn = rest[++i];
    } else if (arg === "--profile" && rest[i + 1]) {
      profile = rest[++i];
    }
  }

  if (sagemakerArn) {
    sagemaker = true;
  }

  const args: ParsedSetupCliArgs = {
    apiKey,
    device,
    force,
    clear,
    sagemaker,
    sagemakerArn,
    profile,
  };

  if (clear && (apiKey || device || sagemaker)) {
    return { args, error: "clear_with_key" };
  }
  if (sagemaker && apiKey) {
    return { args, error: "sagemaker_with_key" };
  }
  if (device && apiKey) {
    return { args, error: "device_with_key" };
  }
  if (device && sagemaker) {
    return { args, error: "device_with_sagemaker" };
  }
  return { args };
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
  hint(
    "This replaces any stored Takara credentials — only one embedding mode is active at a time.",
  );
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

  await beginModeSwitch("sagemaker");
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

  const hadStoredCredentials = Boolean(await readStoredCredentials());
  const path = await saveStoredCredentials({ kind: "sagemaker", endpointArn: arnInput, profile });
  writeStdout("");
  success(`Saved SageMaker config to ${path}`);
  if (hadStoredCredentials) {
    hint("Removed the stored Takara credentials — Miru now embeds only via SageMaker.");
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

  const interactive = options.interactive ?? canPromptForCredentials();
  if (!options.force && hasTakaraApiKeyInEnv() && !options.apiKey && !options.device) {
    const path = resolveCredentialsPath();
    const stored = await readStoredCredentials();
    if (stored?.kind === "sagemaker") {
      const saved = await saveStoredCredentials(resolveEmbeddingApiKey());
      writeStdout("");
      success(`Saved credentials to ${saved}`);
      hint("Removed the stored SageMaker endpoint — Miru now embeds only via Takara.");
      writeStdout("");
      return { path: saved, newlySaved: true };
    }
    if (stored) {
      info(
        `Credentials already configured (env + ${path}). Use --force to replace stored credentials.`,
      );
      return { path, newlySaved: false };
    }
    info("API key already set via environment variable. Stored credentials unchanged.");
    return { path: resolveCredentialsPath(), newlySaved: false };
  }

  if (!options.force) {
    const stored = await readStoredCredentials();
    if (stored && stored.kind !== "sagemaker" && !options.apiKey && !options.device) {
      info(`Credentials already stored at ${resolveCredentialsPath()}. Use --force to replace.`);
      setStoredCredentialsEnvToken(credentialAccessToken(stored));
      return { path: resolveCredentialsPath(), newlySaved: false };
    }
  }

  writeStderr("");
  // stderr: setup/MCP must not write human auth UI to stdout (JSON-RPC / piped CLI).
  printBrandBanner(process.stderr);
  divider("─", 48, process.stderr);
  writeStderr("Miru needs Takara credentials for code embeddings.");
  hint("Device code login is the default. Manual API key entry is still available.");
  hint(
    "This replaces any stored SageMaker endpoint — only one embedding mode is active at a time.",
  );
  writeStderr("");

  await beginModeSwitch("takara");

  const hadSageMaker = (await readStoredCredentials())?.kind === "sagemaker";
  const credentials = await authenticateWithProvider({
    apiKey: options.apiKey,
    device: options.device,
    skipValidation: options.skipValidation,
    allowManualFallback: options.allowManualFallback ?? interactive,
    interactive,
  });
  const path = await saveStoredCredentials(credentials);
  setStoredCredentialsEnvToken(
    credentials.kind === "api_key" ? credentials.apiKey : credentials.accessToken,
  );
  writeStderr("");
  success(`Saved credentials to ${path}`);
  if (hadSageMaker) {
    hint("Removed the stored SageMaker endpoint — Miru now embeds only via Takara.");
  } else {
    hint("MCP loads this key from credentials.json automatically.");
  }
  writeStderr("");
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

  const wantsPrompt = options?.interactive ?? true;
  let refreshError: Error | null = null;
  try {
    await refreshCredentialsFromStore();
  } catch (err) {
    refreshError = err instanceof Error ? err : new Error(String(err));
  }
  if (hasCredentials()) {
    return;
  }

  if (wantsPrompt) {
    writeStderr("");
    if (refreshError) {
      info(`Stored credentials could not be used: ${refreshError.message}`);
      hint("Starting a fresh device-code login.");
    } else {
      info("No Takara credentials found.");
      hint("Starting the same device-code login flow as `miru setup`.");
    }
    await runSetup({
      device: true,
      force: true,
      allowManualFallback: false,
      interactive: true,
    });
    resolveEmbeddingApiKey();
    return;
  }

  if (refreshError) {
    throw refreshError;
  }

  writeStderr("");
  // Brand on stderr when credentials are missing in non-interactive mode (stdout may not be a TTY).
  printBrandBanner(process.stderr);
  writeStderr("");

  throw new Error(
    "Takara credentials required. If you're an agent with Miru MCP tools available, call the " +
      "`auth` tool to sign in. Otherwise run `miru setup` or `miru setup --key TOKEN` in an " +
      "interactive terminal, or set TAKARA_API_KEY in your environment.",
  );
}
