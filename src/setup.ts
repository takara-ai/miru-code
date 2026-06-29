import { brandTitle, divider, hint, info, success, writeStderr } from "./cli-ui.ts";
import { authenticateWithProvider } from "./auth/providers.ts";
import { credentialAccessToken } from "./auth/types.ts";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  resolveCredentialsPath,
  saveStoredCredentials,
  setStoredCredentialsEnvToken,
} from "./credentials.ts";
import { hasTakaraApiKeyInEnv, resolveEmbeddingApiKey } from "./env.ts";

export interface RunSetupOptions {
  apiKey?: string;
  device?: boolean;
  force?: boolean;
  skipValidation?: boolean;
  allowManualFallback?: boolean;
  interactive?: boolean;
}

export interface RunSetupResult {
  path: string;
  newlySaved: boolean;
}

export async function runSetup(options: RunSetupOptions = {}): Promise<RunSetupResult> {
  const interactive = options.interactive ?? canPromptForCredentials();
  if (!options.force && hasTakaraApiKeyInEnv() && !options.apiKey && !options.device) {
    const path = resolveCredentialsPath();
    const stored = await readStoredCredentials();
    if (stored) {
      info(`Credentials already configured (env + ${path}). Use --force to replace stored credentials.`);
      return { path, newlySaved: false };
    }
    info("API key already set via environment variable. Stored credentials unchanged.");
    return { path: resolveCredentialsPath(), newlySaved: false };
  }

  if (!options.force) {
    const stored = await readStoredCredentials();
    if (stored && !options.apiKey && !options.device) {
      info(`Credentials already stored at ${resolveCredentialsPath()}. Use --force to replace.`);
      setStoredCredentialsEnvToken(credentialAccessToken(stored));
      return { path: resolveCredentialsPath(), newlySaved: false };
    }
  }

  writeStderr("");
  writeStderr(`${brandTitle()} setup`);
  divider("─", 48, process.stderr);
  writeStderr("Miru needs Takara credentials for code embeddings.");
  hint("Device code login is the default. Manual API key entry is still available.");
  writeStderr("");

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
  hint("MCP loads credentials from credentials.json automatically.");
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

  throw new Error(
    "Takara credentials required. Initial login must be completed in an interactive terminal. " +
      "Run `miru setup` or `miru setup --key TOKEN`, or set TAKARA_API_KEY in your environment.",
  );
}
