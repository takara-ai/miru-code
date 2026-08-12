export const CREDENTIALS_VERSION = 2;
export const LEGACY_CREDENTIALS_VERSION = 1;

export type StoredCredentialKind = "api_key" | "device_code" | "sagemaker";

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

/** Self-hosted SageMaker embedding endpoint — mutually exclusive with Takara token auth. */
export interface StoredSageMakerCredentials {
  version: typeof CREDENTIALS_VERSION;
  kind: "sagemaker";
  endpoint_arn: string;
  profile?: string;
}

export type StoredCredentials =
  | StoredApiKeyCredentials
  | StoredDeviceCodeCredentials
  | StoredSageMakerCredentials;

/** Pre-v2 credentials.json shape, from before device-code auth and the `kind` discriminator existed. */
export interface LegacyStoredCredentials {
  version: typeof LEGACY_CREDENTIALS_VERSION;
  takara_api_key?: string;
  sagemaker?: { endpoint_arn: string; profile?: string };
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
    }
  | { kind: "sagemaker"; endpointArn: string; profile?: string };

export type AuthenticatedCredentials = Exclude<
  SaveStoredCredentialsInput,
  string | { kind: "sagemaker"; endpointArn: string; profile?: string }
>;

/** Token to hydrate TAKARA_API_KEY with. Not defined for SageMaker (AWS-profile auth, no bearer token). */
export function credentialAccessToken(
  credentials: StoredApiKeyCredentials | StoredDeviceCodeCredentials,
): string {
  return credentials.kind === "api_key" ? credentials.api_key : credentials.access_token;
}
