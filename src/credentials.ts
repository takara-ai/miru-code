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

function hydrateSageMakerEnv(sagemaker: StoredSageMakerCredentials): void {
  process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = sagemaker.endpoint_arn;
  if (sagemaker.profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = sagemaker.profile;
  }
}

/** Hydrate TAKARA_API_KEY / SageMaker env vars from the credentials file when env is unset. */
export async function loadStoredCredentials(): Promise<boolean> {
  normalizeTakaraApiKeyEnv();
  const needsTakara = !hasTakaraApiKeyInEnv();
  const needsSageMaker = !process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
  if (!needsTakara && !needsSageMaker) {
    return false;
  }

  const stored = await readStoredCredentials();
  if (!stored) {
    return false;
  }

  let changed = false;
  if (needsTakara && stored.takara_api_key) {
    process.env.TAKARA_API_KEY = stored.takara_api_key;
    changed = true;
  }
  if (needsSageMaker && stored.sagemaker) {
    hydrateSageMakerEnv(stored.sagemaker);
    changed = true;
  }
  return changed;
}

export async function saveStoredCredentials(apiKey: string): Promise<string> {
  const dir = resolveCredentialsDir();
  const path = resolveCredentialsPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readStoredCredentials();
  const payload: StoredCredentials = {
    version: CREDENTIALS_VERSION,
    takara_api_key: apiKey,
    ...(existing?.sagemaker ? { sagemaker: existing.sagemaker } : {}),
  };
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows may not support Unix mode bits on all filesystems.
  }
  return path;
}

export async function saveStoredSageMakerCredentials(
  sagemaker: StoredSageMakerCredentials,
): Promise<string> {
  const dir = resolveCredentialsDir();
  const path = resolveCredentialsPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readStoredCredentials();
  const payload: StoredCredentials = {
    version: CREDENTIALS_VERSION,
    ...(existing?.takara_api_key ? { takara_api_key: existing.takara_api_key } : {}),
    sagemaker,
  };
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows may not support Unix mode bits on all filesystems.
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
    delete process.env.TAKARA_API_KEY;
  }
  const sagemaker = stored?.sagemaker;
  if (sagemaker) {
    if (process.env.MIRU_SAGEMAKER_ENDPOINT_ARN === sagemaker.endpoint_arn) {
      delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    }
    if (sagemaker.profile && process.env.AWS_PROFILE === sagemaker.profile) {
      delete process.env.AWS_PROFILE;
    }
  }

  return { cleared: true, path };
}
