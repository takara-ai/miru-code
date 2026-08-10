import { describe, expect, test } from "bun:test";
import {
  checkDeviceAuthorizationOnce,
  type DeviceAuthConfig,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from "../src/auth/device.ts";

const CONFIG: DeviceAuthConfig = {
  baseUrl: "https://auth.dev.takara.ai",
  clientId: "miru-code",
  deviceCodePath: "/oauth/device/code",
  tokenPath: "/oauth/token",
};

const START = {
  deviceCode: "device-abc",
  userCode: "ABCD-1234",
  verificationUri: "https://example.vercel.app/platform/device",
  expiresIn: 600,
  interval: 0, // no real delay in tests
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("startDeviceAuthorization", () => {
  test("parses a successful device authorization response", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://example.vercel.app/platform/device",
        expires_in: 600,
        interval: 5,
      })) as typeof fetch;

    const result = await startDeviceAuthorization({ config: CONFIG, fetchImpl });
    expect(result.deviceCode).toBe("device-abc");
    expect(result.userCode).toBe("ABCD-1234");
    expect(result.expiresIn).toBe(600);
  });

  test("throws on a non-ok response", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(500, { error: "boom" })) as typeof fetch;
    await expect(startDeviceAuthorization({ config: CONFIG, fetchImpl })).rejects.toThrow(
      /Device authorization failed/,
    );
  });
});

describe("checkDeviceAuthorizationOnce", () => {
  test("returns success with normalized tokens", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(200, {
        access_token: "access-token-value",
        refresh_token: "refresh-token-value",
        expires_in: 3600,
      })) as typeof fetch;

    const result = await checkDeviceAuthorizationOnce(START, { config: CONFIG, fetchImpl });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.tokens.accessToken).toBe("access-token-value");
      expect(result.tokens.refreshToken).toBe("refresh-token-value");
    }
  });

  test.each([
    ["authorization_pending", "pending"],
    ["slow_down", "slow_down"],
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ] as const)("maps %s to status %s", async (oauthError, status) => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(400, { error: oauthError })) as typeof fetch;
    const result = await checkDeviceAuthorizationOnce(START, { config: CONFIG, fetchImpl });
    expect(result.status).toBe(status);
  });

  test("throws on an unrecognized error code", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(400, { error: "server_error", error_description: "oops" })) as typeof fetch;
    await expect(
      checkDeviceAuthorizationOnce(START, { config: CONFIG, fetchImpl }),
    ).rejects.toThrow(/server_error: oops/);
  });
});

describe("pollDeviceAuthorization", () => {
  test("loops through authorization_pending before succeeding", async () => {
    let calls = 0;
    const fetchImpl = (async (_input, _init) => {
      calls++;
      if (calls < 3) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(200, { access_token: "access-token-value", expires_in: 3600 });
    }) as typeof fetch;

    const tokens = await pollDeviceAuthorization(START, { config: CONFIG, fetchImpl });
    expect(tokens.accessToken).toBe("access-token-value");
    expect(calls).toBe(3);
  });

  test("throws when access is denied", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(400, { error: "access_denied" })) as typeof fetch;
    await expect(pollDeviceAuthorization(START, { config: CONFIG, fetchImpl })).rejects.toThrow(
      /Device login was denied/,
    );
  });
});
