export const CREDENTIALS_VERSION = 2;
export const LEGACY_CREDENTIALS_VERSION = 1;

export type StoredCredentialKind = "api_key" | "device_code";

export interface StoredApiKeyCredentials {
  version: typeof CREDENTIALS_VERSION;
  kind: "api_key";
  api_key: string;
}

export interface StoredDeviceCodeCredentials {
  version: typeof CREDENTIALS_VERSION;
  kind: "device_code";
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  token_type?: string;
  scope?: string;
}

export type StoredCredentials = StoredApiKeyCredentials | StoredDeviceCodeCredentials;

export interface LegacyStoredCredentials {
  version: typeof LEGACY_CREDENTIALS_VERSION;
  takara_api_key: string;
}

export type SaveStoredCredentialsInput =
  | string
  | { kind: "api_key"; apiKey: string }
  | {
      kind: "device_code";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      tokenType?: string;
      scope?: string;
    };

export type AuthenticatedCredentials = Exclude<SaveStoredCredentialsInput, string>;

export function credentialAccessToken(credentials: StoredCredentials): string {
  return credentials.kind === "api_key" ? credentials.api_key : credentials.access_token;
}
