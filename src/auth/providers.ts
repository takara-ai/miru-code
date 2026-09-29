import { dim, warn, writeStderr } from "../cli-ui.ts";
import { validateEmbeddingApiKey } from "../embeddings/validate.ts";
import { promptConfirm } from "../installer/prompt.ts";
import { promptHidden } from "../prompt.ts";
import { Spinner } from "../spinner.ts";
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

export interface AuthProviderDependencies {
  promptHidden?: typeof promptHidden;
  validateApiKey?: typeof validateEmbeddingApiKey;
  promptConfirm?: typeof promptConfirm;
  startDeviceAuthorization?: typeof startDeviceAuthorization;
  pollDeviceAuthorization?: typeof pollDeviceAuthorization;
  openBrowser?: (url: string) => boolean;
}

async function promptApiKey(promptHiddenImpl: typeof promptHidden = promptHidden): Promise<string> {
  let key = "";
  while (!key) {
    key = await promptHiddenImpl("Takara API key (input hidden): ", process.stderr);
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
  if (options.device || options.interactive) {
    return "device_code";
  }
  throw new Error("Choose an auth mode with `miru setup --device` or `miru setup --key TOKEN`.");
}

async function authenticateWithApiKey(
  options: AuthenticateOptions,
  dependencies: AuthProviderDependencies,
): Promise<AuthenticatedCredentials> {
  const apiKey = options.apiKey ?? (await promptApiKey(dependencies.promptHidden));
  if (!options.skipValidation) {
    const spinner = new Spinner("Validating API key");
    spinner.start();
    const result = await (dependencies.validateApiKey ?? validateEmbeddingApiKey)({ apiKey });
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
  dependencies: AuthProviderDependencies,
): Promise<AuthenticatedCredentials> {
  writeStderr("");
  const spinner = new Spinner("Authenticating");
  spinner.start();
  try {
    const start = await (dependencies.startDeviceAuthorization ?? startDeviceAuthorization)();
    const verificationUrl = start.verificationUriComplete ?? start.verificationUri;

    const shouldOpenBrowser =
      options.interactive &&
      (process.env.MIRU_OPEN_BROWSER === undefined || process.env.MIRU_OPEN_BROWSER === "1");
    if (shouldOpenBrowser) {
      (dependencies.openBrowser ?? openBrowserForDeviceLogin)(verificationUrl);
    }

    let visit = dim(`  Visit ${verificationUrl}`);
    if (!start.verificationUriComplete) {
      visit += `\n${dim(`  Code: ${start.userCode}`)}`;
    }
    spinner.follow(visit);

    const tokens = await (dependencies.pollDeviceAuthorization ?? pollDeviceAuthorization)(start);
    spinner.succeed("");
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
      const fallback = await (dependencies.promptConfirm ?? promptConfirm)(
        "Enter an API key instead?",
        true,
      );
      if (fallback) {
        return authenticateWithApiKey(options, dependencies);
      }
    }
    throw err;
  }
}

export async function authenticateWithProvider(
  options: AuthenticateOptions,
  dependencies: AuthProviderDependencies = {},
): Promise<AuthenticatedCredentials> {
  const mode = await resolveAuthMode(options);
  if (mode === "device_code") {
    return authenticateWithDeviceCode(options, dependencies);
  }
  return authenticateWithApiKey(options, dependencies);
}
