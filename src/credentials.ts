import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasTakaraApiKeyInEnv, normalizeTakaraApiKeyEnv } from "./env.ts";
import {
  deviceCredentialsNeedRefresh,
  refreshDeviceAuthorization,
} from "./auth/device.ts";
import {
  CREDENTIALS_VERSION,
  LEGACY_CREDENTIALS_VERSION,
  type LegacyStoredCredentials,
  type SaveStoredCredentialsInput,
  type StoredCredentials,
  credentialAccessToken,
} from "./auth/types.ts";

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
    if (parsed.version === LEGACY_CREDENTIALS_VERSION && parsed.takara_api_key?.trim()) {
      return {
        version: CREDENTIALS_VERSION,
        kind: "api_key",
        api_key: parsed.takara_api_key,
      };
    }
    if (parsed.version !== CREDENTIALS_VERSION || !("kind" in parsed)) {
      return null;
    }
    if (parsed.kind === "api_key" && parsed.api_key?.trim()) {
      return parsed;
    }
    if (parsed.kind === "device_code") {
      if (!parsed.access_token?.trim()) {
        throw new Error(
          "Stored device credentials are incomplete. Run `miru setup --device` again or `miru setup --clear`.",
        );
      }
      return parsed;
    }
    return null;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Stored device credentials are incomplete")) {
      throw err;
    }
    return null;
  }
}

function envUsesStoredToken(): boolean {
  return activeStoredToken !== null && process.env.TAKARA_API_KEY === activeStoredToken;
}

function markLoadedToken(token: string): void {
  setStoredCredentialsEnvToken(token);
}

/** Set TAKARA_API_KEY from the user credentials file when env is unset. */
export async function loadStoredCredentials(): Promise<boolean> {
  normalizeTakaraApiKeyEnv();
  if (hasTakaraApiKeyInEnv() && !envUsesStoredToken()) {
    return false;
  }
  const stored = await readStoredCredentials();
  if (!stored) {
    return false;
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
  return path;
}

export async function clearStoredCredentials(): Promise<{ cleared: boolean; path: string }> {
  const path = resolveCredentialsPath();
  if (!(await Bun.file(path).exists())) {
    return { cleared: false, path };
  }

  const stored = await readStoredCredentials();
  await rm(path, { force: true });

  if (stored && process.env.TAKARA_API_KEY === credentialAccessToken(stored)) {
    delete process.env.TAKARA_API_KEY;
  }
  activeStoredToken = null;

  return { cleared: true, path };
}
