import { envFirstString } from "../env.ts";
import type { StoredDeviceCodeCredentials } from "./types.ts";

const DEFAULT_AUTH_BASE_URL = "https://auth.takara.ai";
const DEFAULT_DEVICE_CODE_PATH = "/oauth/device/code";
const DEFAULT_TOKEN_PATH = "/oauth/token";
const DEFAULT_CLIENT_ID = "miru-code";
const EXPIRY_SKEW_MS = 60_000;

export interface DeviceAuthConfig {
  baseUrl: string;
  clientId: string;
  scope?: string;
  audience?: string;
  deviceCodePath: string;
  tokenPath: string;
}

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceAuthorizationTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

interface OAuthTokenSuccess {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface OAuthTokenError {
  error?: string;
  error_description?: string;
}

export function resolveDeviceAuthConfig(): DeviceAuthConfig {
  return {
    baseUrl: envFirstString(["MIRU_AUTH_BASE_URL"], DEFAULT_AUTH_BASE_URL).replace(/\/$/, ""),
    clientId: envFirstString(["MIRU_AUTH_CLIENT_ID"], DEFAULT_CLIENT_ID),
    scope: process.env.MIRU_AUTH_SCOPE?.trim() || undefined,
    audience: process.env.MIRU_AUTH_AUDIENCE?.trim() || undefined,
    deviceCodePath: process.env.MIRU_DEVICE_CODE_PATH?.trim() || DEFAULT_DEVICE_CODE_PATH,
    tokenPath: process.env.MIRU_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH,
  };
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

function tokenExpiryToIso(expiresIn?: number): string | undefined {
  if (expiresIn == null || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeTokenSuccess(payload: OAuthTokenSuccess): DeviceAuthorizationTokens {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: tokenExpiryToIso(payload.expires_in),
    tokenType: payload.token_type,
    scope: payload.scope,
  };
}

function parseTokenError(payload: OAuthTokenError): string {
  const code = payload.error?.trim();
  const description = payload.error_description?.trim();
  if (code && description) {
    return `${code}: ${description}`;
  }
  return code || description || "unknown_error";
}

async function postForm(
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export async function startDeviceAuthorization(
  options?: { config?: DeviceAuthConfig; fetchImpl?: typeof fetch },
): Promise<DeviceAuthorizationStart> {
  const config = options?.config ?? resolveDeviceAuthConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: config.clientId });
  if (config.scope) {
    body.set("scope", config.scope);
  }
  if (config.audience) {
    body.set("audience", config.audience);
  }

  const response = await postForm(
    resolveUrl(config.baseUrl, config.deviceCodePath),
    body,
    fetchImpl,
  );
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(`Device authorization failed: ${text || response.statusText}`);
  }

  const deviceCode = String(payload.device_code ?? "").trim();
  const userCode = String(payload.user_code ?? "").trim();
  const verificationUri = String(
    payload.verification_uri ?? payload.verification_url ?? "",
  ).trim();
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Device authorization response was missing required fields.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof payload.verification_uri_complete === "string"
        ? payload.verification_uri_complete
        : undefined,
    expiresIn:
      typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 600,
    interval:
      typeof payload.interval === "number" && payload.interval >= 0 ? payload.interval : 5,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollDeviceAuthorization(
  start: DeviceAuthorizationStart,
  options?: { config?: DeviceAuthConfig; fetchImpl?: typeof fetch },
): Promise<DeviceAuthorizationTokens> {
  const config = options?.config ?? resolveDeviceAuthConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const deadline = Date.now() + start.expiresIn * 1000;
  let intervalMs = start.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: start.deviceCode,
      client_id: config.clientId,
    });
    const response = await postForm(resolveUrl(config.baseUrl, config.tokenPath), body, fetchImpl);
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as OAuthTokenSuccess | OAuthTokenError) : {};

    if (response.ok) {
      const success = payload as OAuthTokenSuccess;
      if (!success.access_token?.trim()) {
        throw new Error("Device login succeeded but did not return an access token.");
      }
      return normalizeTokenSuccess(success);
    }

    const error = (payload as OAuthTokenError).error;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied") {
      throw new Error("Device login was denied.");
    }
    if (error === "expired_token") {
      throw new Error("Device login expired before it was completed.");
    }
    throw new Error(`Device login failed: ${parseTokenError(payload as OAuthTokenError)}`);
  }

  throw new Error("Device login timed out before it was completed.");
}

export async function refreshDeviceAuthorization(
  credentials: StoredDeviceCodeCredentials,
  options?: { config?: DeviceAuthConfig; fetchImpl?: typeof fetch },
): Promise<DeviceAuthorizationTokens> {
  if (!credentials.refresh_token?.trim()) {
    throw new Error("Stored device credentials cannot be refreshed because no refresh token exists.");
  }

  const config = options?.config ?? resolveDeviceAuthConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: config.clientId,
  });
  const response = await postForm(resolveUrl(config.baseUrl, config.tokenPath), body, fetchImpl);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as OAuthTokenSuccess | OAuthTokenError) : {};

  if (!response.ok) {
    throw new Error(`Device token refresh failed: ${parseTokenError(payload as OAuthTokenError)}`);
  }

  const success = payload as OAuthTokenSuccess;
  if (!success.access_token?.trim()) {
    throw new Error("Token refresh succeeded but did not return an access token.");
  }

  return normalizeTokenSuccess({
    ...success,
    refresh_token: success.refresh_token ?? credentials.refresh_token,
  });
}

export function deviceCredentialsNeedRefresh(credentials: StoredDeviceCodeCredentials): boolean {
  if (!credentials.expires_at) {
    return false;
  }
  const expiresAt = Date.parse(credentials.expires_at);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt <= Date.now() + EXPIRY_SKEW_MS;
}

export function openBrowserForDeviceLogin(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    void proc.exited;
    return true;
  } catch {
    return false;
  }
}
