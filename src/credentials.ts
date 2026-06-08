import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasTakaraApiKeyInEnv, normalizeTakaraApiKeyEnv } from "./env.ts";

const CREDENTIALS_FILENAME = "credentials.json";
const CREDENTIALS_VERSION = 1;

interface StoredCredentials {
  version: number;
  takara_api_key: string;
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

export function resolveCredentialsPath(): string {
  return join(resolveCredentialsDir(), CREDENTIALS_FILENAME);
}

export async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as StoredCredentials;
    if (parsed.version !== CREDENTIALS_VERSION || !parsed.takara_api_key) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Set TAKARA_API_KEY from the user credentials file when env is unset. */
export async function loadStoredCredentials(): Promise<boolean> {
  normalizeTakaraApiKeyEnv();
  if (hasTakaraApiKeyInEnv()) {
    return false;
  }
  const stored = await readStoredCredentials();
  if (!stored) {
    return false;
  }
  process.env.TAKARA_API_KEY = stored.takara_api_key;
  return true;
}

export async function saveStoredCredentials(apiKey: string): Promise<string> {
  const dir = resolveCredentialsDir();
  const path = resolveCredentialsPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload: StoredCredentials = {
    version: CREDENTIALS_VERSION,
    takara_api_key: apiKey,
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
  return path;
}

export async function clearStoredCredentials(): Promise<{ cleared: boolean; path: string }> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return { cleared: false, path };
  }

  const stored = await readStoredCredentials();
  await rm(path, { force: true });

  if (stored && process.env.TAKARA_API_KEY === stored.takara_api_key) {
    delete process.env.TAKARA_API_KEY;
  }

  return { cleared: true, path };
}
