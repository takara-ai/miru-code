import { stdout as output } from "node:process";
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
      output.write("API key cannot be empty.\n");
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
      process.stderr.write(
        `API key already configured (env var and ${path}). Use --force to replace the stored key.\n`,
      );
      return path;
    }
    process.stderr.write(
      "API key already set via environment variable. Stored credentials were not changed.\n",
    );
    return resolveCredentialsPath();
  }

  if (!options.force) {
    const stored = await readStoredCredentials();
    if (stored && !options.apiKey) {
      process.stderr.write(
        `API key already stored at ${resolveCredentialsPath()}. Use --force to replace it.\n`,
      );
      process.env.TAKARA_API_KEY = stored.takara_api_key;
      return resolveCredentialsPath();
    }
  }

  process.stderr.write("\nMiru (見る) — first-time setup\n\n");
  process.stderr.write(
    "Miru needs a Takara API key for code embeddings.\n" +
      "Get a bearer token from Takara, then enter it below.\n\n",
  );

  const apiKey = options.apiKey ?? (await promptApiKey());

  if (!options.skipValidation) {
    const spinner = new Spinner("Validating API key");
    spinner.start();
    const result = await validateEmbeddingApiKey({ apiKey });
    if (!result.valid) {
      spinner.fail(result.message);
      throw new Error(result.message);
    }
    spinner.succeed("API key validated");
  }

  const path = await saveStoredCredentials(apiKey);
  process.env.TAKARA_API_KEY = apiKey;
  process.stderr.write(`\nSaved credentials to ${path} (readable only by your user account).\n`);
  process.stderr.write("You can also set TAKARA_API_KEY in MCP config for IDE integrations.\n\n");
  return path;
}

export async function runClearCredentials(): Promise<void> {
  const { cleared, path } = await clearStoredCredentials();
  if (cleared) {
    process.stderr.write(`Removed stored API key from ${path}.\n`);
    return;
  }
  process.stderr.write(`No stored API key at ${path}.\n`);
}

export async function ensureCredentials(options?: { interactive?: boolean }): Promise<void> {
  try {
    resolveEmbeddingApiKey();
    return;
  } catch {
    await loadStoredCredentials();
  }

  try {
    resolveEmbeddingApiKey();
    return;
  } catch {
    // still missing
  }

  const interactive = options?.interactive ?? process.stdin.isTTY;
  if (interactive) {
    await runSetup();
    resolveEmbeddingApiKey();
    return;
  }

  throw new Error(
    "Embedding API key required. Run `miru setup` in a terminal, or set TAKARA_API_KEY " +
      "in your MCP server env (Cursor mcp.json) or .env.local.",
  );
}
