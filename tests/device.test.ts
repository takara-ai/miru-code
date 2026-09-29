import { describe, expect, test } from "bun:test";
import {
  checkDeviceAuthorizationOnce,
  type DeviceAuthConfig,
  deviceCredentialsNeedRefresh,
  openBrowserForDeviceLogin,
  pollDeviceAuthorization,
  refreshDeviceAuthorization,
  startDeviceAuthorization,
} from "../src/auth/device.ts";
import { CREDENTIALS_VERSION, type StoredDeviceCodeCredentials } from "../src/auth/types.ts";

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
    const fetchImpl = (async (_input: unknown, _init?: RequestInit) =>
      jsonResponse(200, {
        device_code: "device-abc",
        user_code: "ABCD-1234",
        verification_uri: "https://example.vercel.app/platform/device",
        expires_in: 600,
        interval: 5,
      })) as unknown as typeof fetch;

    const result = await startDeviceAuthorization({ config: CONFIG, fetchImpl });
    expect(result.deviceCode).toBe("device-abc");
    expect(result.userCode).toBe("ABCD-1234");
    expect(result.expiresIn).toBe(600);
  });

  test("sends optional scope and audience and accepts a nonpositive expiry fallback", async () => {
    let sentBody = "";
    const result = await startDeviceAuthorization({
      config: { ...CONFIG, scope: "openid profile", audience: "miru-api" },
      fetchImpl: (async (_input, init) => {
        sentBody = String(init?.body);
        return jsonResponse(200, {
          device_code: "device-abc",
          user_code: "ABCD-1234",
          verification_uri: "https://example.test/device",
          expires_in: 0,
          interval: 5,
        });
      }) as typeof fetch,
    });
    expect(sentBody).toContain("scope=openid+profile");
    expect(sentBody).toContain("audience=miru-api");
    expect(result.expiresIn).toBe(600);
  });

  test("throws on a non-ok response", async () => {
    const fetchImpl = (async (_input, _init) =>
      jsonResponse(500, { error: "boom" })) as typeof fetch;
    await expect(startDeviceAuthorization({ config: CONFIG, fetchImpl })).rejects.toThrow(
      /Device authorization failed/,
    );
  });

  test("uses defaults for invalid optional response fields and accepts verification_url", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        device_code: " code ",
        user_code: " user ",
        verification_url: " https://verify.test ",
        expires_in: -1,
        interval: -1,
        verification_uri_complete: "https://verify.test/ABCD",
      })) as unknown as typeof fetch;
    const result = await startDeviceAuthorization({ config: CONFIG, fetchImpl });
    expect(result).toEqual({
      deviceCode: "code",
      userCode: "user",
      verificationUri: "https://verify.test",
      verificationUriComplete: "https://verify.test/ABCD",
      expiresIn: 600,
      interval: 5,
    });
    await expect(
      startDeviceAuthorization({
        config: CONFIG,
        fetchImpl: (async () => jsonResponse(200, {})) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("missing required fields");
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

  test("accepts successful tokens without a usable expiry", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { access_token: "access-token-value" })) as unknown as typeof fetch;
    const result = await checkDeviceAuthorizationOnce(START, { config: CONFIG, fetchImpl });
    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-token-value" },
    });
    if (result.status === "success") expect(result.tokens.expiresAt).toBeUndefined();
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

  test("rejects successful responses that omit the access token", async () => {
    await expect(
      checkDeviceAuthorizationOnce(START, {
        config: CONFIG,
        fetchImpl: (async () =>
          jsonResponse(200, { access_token: " " })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("did not return an access token");
  });
});

describe("pollDeviceAuthorization", () => {
  test("loops through authorization_pending before succeeding", async () => {
    let calls = 0;
    const fetchImpl = (async (_input: unknown, _init?: RequestInit) => {
      calls++;
      if (calls < 3) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(200, { access_token: "access-token-value", expires_in: 3600 });
    }) as unknown as typeof fetch;

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

  test("increases the polling interval after slow_down and times out at expiry", async () => {
    const intervals: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(400, { error: "slow_down" });
      if (calls === 2) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(400, { error: "expired_token" });
    }) as unknown as typeof fetch;
    await expect(
      pollDeviceAuthorization(
        { ...START, interval: 0 },
        {
          config: CONFIG,
          fetchImpl,
          sleepImpl: async (ms) => {
            intervals.push(ms);
          },
        },
      ),
    ).rejects.toThrow("expired");
    expect(calls).toBe(3);
    expect(intervals).toEqual([0, 5_000, 5_000]);

    await expect(
      pollDeviceAuthorization(
        { ...START, expiresIn: 0 },
        {
          config: CONFIG,
          fetchImpl,
          sleepImpl: async () => {},
        },
      ),
    ).rejects.toThrow("timed out");
  });
});

describe("device credential refresh", () => {
  const credentials: StoredDeviceCodeCredentials = {
    version: CREDENTIALS_VERSION,
    kind: "device_code",
    access_token: "old-access",
    refresh_token: "old-refresh",
  };

  test("refreshes tokens and retains the old refresh token when the provider omits a replacement", async () => {
    const fetchImpl = (async (_input, init) => {
      expect(String(init?.body)).toContain("refresh_token=old-refresh");
      return jsonResponse(200, {
        access_token: "new-access",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as typeof fetch;
    const result = await refreshDeviceAuthorization(credentials, { config: CONFIG, fetchImpl });
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("old-refresh");
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresAt).toBeString();
  });

  test("reports missing, rejected, and malformed refresh credentials", async () => {
    await expect(
      refreshDeviceAuthorization({ ...credentials, refresh_token: " " }, { config: CONFIG }),
    ).rejects.toThrow("no refresh token");
    await expect(
      refreshDeviceAuthorization(credentials, {
        config: CONFIG,
        fetchImpl: (async () =>
          jsonResponse(400, { error: "invalid_grant" })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("invalid_grant");
    await expect(
      refreshDeviceAuthorization(credentials, {
        config: CONFIG,
        fetchImpl: (async () => jsonResponse(200, {})) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("did not return an access token");
  });

  test("detects refresh boundaries, invalid dates, and absent expiry values", () => {
    expect(deviceCredentialsNeedRefresh(credentials)).toBe(false);
    expect(deviceCredentialsNeedRefresh({ ...credentials, expires_at: "not-a-date" })).toBe(true);
    expect(
      deviceCredentialsNeedRefresh({
        ...credentials,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      }),
    ).toBe(false);
    expect(
      deviceCredentialsNeedRefresh({
        ...credentials,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).toBe(true);
  });
});

describe("openBrowserForDeviceLogin", () => {
  test("selects platform commands and handles spawn errors", () => {
    const calls: string[][] = [];
    const spawn = ((command: string[]) => {
      calls.push(command);
      return { unref: () => calls.push(["unref"]) };
    }) as unknown as typeof Bun.spawn;
    expect(openBrowserForDeviceLogin("https://example.test", "darwin", spawn)).toBe(true);
    expect(openBrowserForDeviceLogin("https://example.test", "win32", spawn)).toBe(true);
    expect(openBrowserForDeviceLogin("https://example.test", "linux", spawn)).toBe(true);
    expect(calls).toContainEqual(["open", "https://example.test"]);
    expect(calls).toContainEqual(["cmd", "/c", "start", "", "https://example.test"]);
    expect(calls).toContainEqual(["xdg-open", "https://example.test"]);
    expect(
      openBrowserForDeviceLogin("https://example.test", "linux", (() => {
        throw new Error("missing");
      }) as unknown as typeof Bun.spawn),
    ).toBe(false);
  });
});
