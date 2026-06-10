import { brandTitle, divider, fail, hint, info, success, writeStderr } from "./cli-ui.ts";
import {
  clearStoredCredentials,
  loadStoredCredentials,
  readStoredCredentials,
  resolveCredentialsPath,
  saveStoredCredentials,
} from "./credentials.ts";
import { validateEmbeddingApiKey } from "./embeddings/validate.ts";
import { hasTakaraApiKeyInEnv, resolveEmbeddingApiKey } from "./env.ts";
import { promptHidden } from "./prompt.ts";
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
}

export async function runSetup(options: RunSetupOptions = {}): Promise<string> {
  if (!options.force && hasTakaraApiKeyInEnv()) {
    const path = resolveCredentialsPath();
    const stored = await readStoredCredentials();
    if (stored) {
      info(`API key already configured (env + ${path}). Use --force to replace stored key.`);
      return path;
    }
    info("API key already set via environment variable. Stored credentials unchanged.");
    return resolveCredentialsPath();
  }

  if (!options.force) {
    const stored = await readStoredCredentials();
    if (stored && !options.apiKey) {
      info(`API key already stored at ${resolveCredentialsPath()}. Use --force to replace.`);
      process.env.TAKARA_API_KEY = stored.takara_api_key;
      return resolveCredentialsPath();
    }
  }

  writeStderr("");
  writeStderr(`${brandTitle()} setup`);
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
  return path;
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

  throw new Error(
    "Takara API key required. Run `miru setup` in a terminal, or set TAKARA_API_KEY " +
      "in your MCP server env (Cursor mcp.json) or .env.local.",
  );
}
