import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hasTakaraApiKeyInEnv, normalizeTakaraApiKeyEnv } from "./env.ts";

const CREDENTIALS_FILENAME = "credentials.json";
const CREDENTIALS_VERSION = 1;

export interface StoredSageMakerCredentials {
  endpoint_arn: string;
  profile?: string;
}

interface StoredCredentials {
  version: number;
  takara_api_key?: string;
  sagemaker?: StoredSageMakerCredentials;
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
    const parsed = JSON.parse(await Bun.file(path).text()) as StoredCredentials;
    if (parsed.version !== CREDENTIALS_VERSION || (!parsed.takara_api_key && !parsed.sagemaker)) {
      return null;
    }
    return parsed;
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
    clearSageMakerEnv(stored?.sagemaker);
  } else {
    clearTakaraEnv();
  }
}

async function writeExclusive(payload: StoredCredentials): Promise<string> {
  const dir = resolveCredentialsDir();
  const path = resolveCredentialsPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows may not support Unix mode bits on all filesystems.
  }
  return path;
}

/** Apply credentials.json as the sole mode — never leave Takara and SageMaker both active. */
export async function loadStoredCredentials(): Promise<boolean> {
  normalizeTakaraApiKeyEnv();
  const stored = await readStoredCredentials();
  if (!stored) {
    return false;
  }

  if (stored.takara_api_key) {
    let changed = false;
    if (!hasTakaraApiKeyInEnv()) {
      process.env.TAKARA_API_KEY = stored.takara_api_key;
      changed = true;
    }
    if (process.env.MIRU_SAGEMAKER_ENDPOINT_ARN || process.env.MIRU_SAGEMAKER_ENDPOINT_NAME) {
      clearSageMakerEnv(stored.sagemaker);
      changed = true;
    }
    return changed;
  }

  if (stored.sagemaker) {
    let changed = false;
    if (!process.env.MIRU_SAGEMAKER_ENDPOINT_ARN?.trim()) {
      hydrateSageMakerEnv(stored.sagemaker);
      changed = true;
    }
    if (hasTakaraApiKeyInEnv()) {
      clearTakaraEnv();
      changed = true;
    }
    return changed;
  }
  return false;
}

export async function saveStoredCredentials(apiKey: string): Promise<string> {
  const previous = await readStoredCredentials();
  const path = await writeExclusive({ version: CREDENTIALS_VERSION, takara_api_key: apiKey });
  process.env.TAKARA_API_KEY = apiKey;
  clearSageMakerEnv(previous?.sagemaker);
  return path;
}

export async function saveStoredSageMakerCredentials(
  sagemaker: StoredSageMakerCredentials,
): Promise<string> {
  const path = await writeExclusive({ version: CREDENTIALS_VERSION, sagemaker });
  clearTakaraEnv();
  process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = sagemaker.endpoint_arn;
  if (sagemaker.profile) {
    process.env.AWS_PROFILE = sagemaker.profile;
  }
  return path;
}

export async function clearStoredCredentials(): Promise<{ cleared: boolean; path: string }> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return { cleared: false, path };
  }

  const stored = await readStoredCredentials();
  await Bun.file(path).delete();

  if (stored?.takara_api_key && process.env.TAKARA_API_KEY === stored.takara_api_key) {
    clearTakaraEnv();
  }
  if (stored?.sagemaker) {
    clearSageMakerEnv(stored.sagemaker);
  }

  return { cleared: true, path };
}
