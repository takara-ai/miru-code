import { hint, info, warn, writeStderr } from "../cli-ui.ts";
import { promptHidden } from "../prompt.ts";
import { Spinner } from "../spinner.ts";
import { validateEmbeddingApiKey } from "../embeddings/validate.ts";
import { promptConfirm } from "../installer/prompt.ts";
import {
  openBrowserForDeviceLogin,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from "./device.ts";
import type { AuthenticatedCredentials } from "./types.ts";

export type AuthMode = "api_key" | "device_code";

export interface AuthenticateOptions {
  apiKey?: string;
  device?: boolean;
  skipValidation?: boolean;
  allowManualFallback?: boolean;
  interactive?: boolean;
}

async function promptApiKey(): Promise<string> {
  let key = "";
  while (!key) {
    key = await promptHidden("Takara API key (input hidden): ", process.stderr);
    if (!key) {
      warn("API key cannot be empty.");
    }
  }
  return key;
}

async function resolveAuthMode(options: AuthenticateOptions): Promise<AuthMode> {
  if (options.apiKey) {
    return "api_key";
  }
  if (options.device) {
    return "device_code";
  }
  if (!options.interactive) {
    throw new Error("Choose an auth mode with `miru setup --device` or `miru setup --key TOKEN`.");
  }
  writeStderr("");
  info("Choose how to authenticate.");
  const useDevice = await promptConfirm("Use device code login?", true);
  return useDevice ? "device_code" : "api_key";
}

async function authenticateWithApiKey(options: AuthenticateOptions): Promise<AuthenticatedCredentials> {
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
  return { kind: "api_key", apiKey };
}

async function authenticateWithDeviceCode(
  options: AuthenticateOptions,
): Promise<AuthenticatedCredentials> {
  const start = await startDeviceAuthorization();
  writeStderr("");
  info(`Open ${start.verificationUri}`);
  hint(`Code: ${start.userCode}`);
  if (start.verificationUriComplete) {
    hint(`Direct link: ${start.verificationUriComplete}`);
  }
  if (options.interactive) {
    const shouldOpenBrowser =
      process.env.MIRU_OPEN_BROWSER === undefined || process.env.MIRU_OPEN_BROWSER === "1";
    if (shouldOpenBrowser && openBrowserForDeviceLogin(start.verificationUriComplete ?? start.verificationUri)) {
      hint("Opened the verification page in your browser.");
    }
  }

  const spinner = new Spinner("Waiting for device authorization");
  spinner.start();
  try {
    const tokens = await pollDeviceAuthorization(start);
    spinner.succeed("Device login completed");
    return {
      kind: "device_code",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
    };
  } catch (err) {
    spinner.stop();
    if (options.allowManualFallback && options.interactive) {
      warn(err instanceof Error ? err.message : String(err));
      const fallback = await promptConfirm("Enter an API key instead?", true);
      if (fallback) {
        return authenticateWithApiKey(options);
      }
    }
    throw err;
  }
}

export async function authenticateWithProvider(
  options: AuthenticateOptions,
): Promise<AuthenticatedCredentials> {
  const mode = await resolveAuthMode(options);
  if (mode === "device_code") {
    return authenticateWithDeviceCode(options);
  }
  return authenticateWithApiKey(options);
}
