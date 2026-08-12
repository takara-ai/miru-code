import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceCredentialsNeedRefresh, refreshDeviceAuthorization } from "./auth/device.ts";
import {
  CREDENTIALS_VERSION,
  credentialAccessToken,
  LEGACY_CREDENTIALS_VERSION,
  type LegacyStoredCredentials,
  type SaveStoredCredentialsInput,
  type StoredCredentials,
  type StoredSageMakerCredentials,
} from "./auth/types.ts";
import { hasTakaraApiKeyInEnv, normalizeTakaraApiKeyEnv } from "./env.ts";

const CREDENTIALS_FILENAME = "credentials.json";
let activeStoredToken: string | null = null;

export function setStoredCredentialsEnvToken(token: string): void {
  activeStoredToken = token;
  process.env.TAKARA_API_KEY = token;
}

export function resolveCredentialsDir(): string {
  const override = process.env.MIRU_CREDENTIALS_DIR;
  if (override) {
    return override;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(base, "miru");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "miru");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdg, "miru");
}

/**
 * Global Miru state directory (credentials, benchmark history, etc.).
 * Same location as `resolveCredentialsDir()`; prefer this name for non-secret files.
 */
export function resolveMiruStateDir(): string {
  return resolveCredentialsDir();
}

export function resolveCredentialsPath(): string {
  return join(resolveCredentialsDir(), CREDENTIALS_FILENAME);
}

export async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as
      | StoredCredentials
      | LegacyStoredCredentials;
    if (parsed.version === LEGACY_CREDENTIALS_VERSION) {
      if (parsed.sagemaker) {
        return {
          version: CREDENTIALS_VERSION,
          kind: "sagemaker",
          endpoint_arn: parsed.sagemaker.endpoint_arn,
          profile: parsed.sagemaker.profile,
        };
      }
      if (parsed.takara_api_key?.trim()) {
        return {
          version: CREDENTIALS_VERSION,
          kind: "api_key",
          api_key: parsed.takara_api_key,
        };
      }
      return null;
    }
    if (parsed.version !== CREDENTIALS_VERSION || !("kind" in parsed)) {
      return null;
    }
    if (parsed.kind === "api_key" && parsed.api_key?.trim()) {
      return parsed;
    }
    if (parsed.kind === "sagemaker" && parsed.endpoint_arn?.trim()) {
      return parsed;
    }
    if (parsed.kind === "device_code") {
      if (!parsed.access_token?.trim()) {
        // Treat incomplete device files as absent so `setup --clear` and recovery can proceed.
        return null;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearSageMakerEnv(sagemaker?: StoredSageMakerCredentials): void {
  delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  delete process.env.MIRU_SAGEMAKER_ENDPOINT_NAME;
  delete process.env.MIRU_SAGEMAKER_REGION;
  if (sagemaker?.profile && process.env.AWS_PROFILE === sagemaker.profile) {
    delete process.env.AWS_PROFILE;
  }
}

function clearTakaraEnv(): void {
  delete process.env.TAKARA_API_KEY;
}

function hydrateSageMakerEnv(sagemaker: StoredSageMakerCredentials): void {
  process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = sagemaker.endpoint_arn;
  if (sagemaker.profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = sagemaker.profile;
  }
}

/** Drop the other backend from env so setup validation cannot see a stale mode. */
export async function beginModeSwitch(to: "takara" | "sagemaker"): Promise<void> {
  const stored = await readStoredCredentials();
  if (to === "takara") {
    clearSageMakerEnv(stored?.kind === "sagemaker" ? stored : undefined);
  } else {
    clearTakaraEnv();
  }
}

function envUsesStoredToken(): boolean {
  return activeStoredToken !== null && process.env.TAKARA_API_KEY === activeStoredToken;
}

function markLoadedToken(token: string): void {
  setStoredCredentialsEnvToken(token);
}

/** Hydrate TAKARA_API_KEY / SageMaker env vars from the credentials file when env is unset. */
export async function loadStoredCredentials(): Promise<boolean> {
  normalizeTakaraApiKeyEnv();
  const stored = await readStoredCredentials();
  if (!stored) {
    return false;
  }

  if (stored.kind === "sagemaker") {
    let changed = false;
    if (!process.env.MIRU_SAGEMAKER_ENDPOINT_ARN?.trim()) {
      hydrateSageMakerEnv(stored);
      changed = true;
    }
    if (hasTakaraApiKeyInEnv()) {
      clearTakaraEnv();
      changed = true;
    }
    return changed;
  }

  // Takara token modes (api_key / device_code) are mutually exclusive with SageMaker.
  const needsSageMakerClear = Boolean(
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN || process.env.MIRU_SAGEMAKER_ENDPOINT_NAME,
  );
  const needsToken = !hasTakaraApiKeyInEnv() || envUsesStoredToken();

  if (!needsToken && !needsSageMakerClear) {
    return false;
  }

  if (needsSageMakerClear) {
    clearSageMakerEnv();
  }

  if (!needsToken) {
    return true;
  }

  if (stored.kind === "device_code" && deviceCredentialsNeedRefresh(stored)) {
    const refreshed = await refreshDeviceAuthorization(stored);
    await saveStoredCredentials({
      kind: "device_code",
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType,
      scope: refreshed.scope,
    });
    markLoadedToken(refreshed.accessToken);
    return true;
  }
  markLoadedToken(credentialAccessToken(stored));
  return true;
}

export async function saveStoredCredentials(input: SaveStoredCredentialsInput): Promise<string> {
  const dir = resolveCredentialsDir();
  const path = resolveCredentialsPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const payload: StoredCredentials =
    typeof input === "string" || input.kind === "api_key"
      ? {
          version: CREDENTIALS_VERSION,
          kind: "api_key",
          api_key: typeof input === "string" ? input : input.apiKey,
        }
      : input.kind === "sagemaker"
        ? {
            version: CREDENTIALS_VERSION,
            kind: "sagemaker",
            endpoint_arn: input.endpointArn,
            profile: input.profile,
          }
        : {
            version: CREDENTIALS_VERSION,
            kind: "device_code",
            access_token: input.accessToken,
            refresh_token: input.refreshToken,
            expires_at: input.expiresAt,
            token_type: input.tokenType,
            scope: input.scope,
          };

  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows may not support Unix mode bits on all filesystems.
  }

  // Takara-token and SageMaker modes are mutually exclusive — activating one mode
  // unconditionally drops the other's env state, regardless of its current value.
  if (payload.kind === "sagemaker") {
    clearTakaraEnv();
    activeStoredToken = null;
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = payload.endpoint_arn;
    if (payload.profile) {
      process.env.AWS_PROFILE = payload.profile;
    }
  } else {
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_NAME;
    delete process.env.MIRU_SAGEMAKER_REGION;
    delete process.env.AWS_PROFILE;
    // api_key saves activate immediately; device_code saves (initial login or refresh)
    // leave env hydration to the caller (setup.ts / loadStoredCredentials refresh path).
    if (payload.kind === "api_key") {
      setStoredCredentialsEnvToken(payload.api_key);
    }
  }

  return path;
}

export async function clearStoredCredentials(): Promise<{ cleared: boolean; path: string }> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return { cleared: false, path };
  }

  // Read for env cleanup, but never let parse errors block deletion.
  let stored: StoredCredentials | null = null;
  try {
    stored = await readStoredCredentials();
  } catch {
    // Ignore parse/read errors — removal still proceeds.
  }
  await rm(path, { force: true });

  if (stored) {
    if (stored.kind === "sagemaker") {
      if (process.env.MIRU_SAGEMAKER_ENDPOINT_ARN === stored.endpoint_arn) {
        delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
      }
      if (stored.profile && process.env.AWS_PROFILE === stored.profile) {
        delete process.env.AWS_PROFILE;
      }
    } else if (process.env.TAKARA_API_KEY === credentialAccessToken(stored)) {
      delete process.env.TAKARA_API_KEY;
    }
  }
  activeStoredToken = null;

  return { cleared: true, path };
}
