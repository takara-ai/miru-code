import { describe, expect, test } from "bun:test";
import { authenticateWithProvider } from "../src/auth/providers.ts";
import { fake } from "./helpers/fake-credentials.ts";

describe("authenticateWithProvider", () => {
  test("requires a mode and validates API keys when requested", async () => {
    await expect(authenticateWithProvider({})).rejects.toThrow("Choose an auth mode");
    const result = await authenticateWithProvider(
      { apiKey: "key" },
      {
        validateApiKey: async ({ apiKey }) => ({ valid: apiKey === "key", message: "valid" }),
      },
    );
    expect(result).toEqual({ kind: "api_key", apiKey: "key" });

    await expect(
      authenticateWithProvider(
        { apiKey: "bad" },
        {
          validateApiKey: async () => ({ valid: false, message: "rejected" }),
        },
      ),
    ).rejects.toThrow("rejected");
  });

  test("re-prompts for an empty manual key and returns it when validation is skipped", async () => {
    let prompts = 0;
    const result = await authenticateWithProvider(
      { device: true, interactive: true, skipValidation: true, allowManualFallback: true },
      {
        startDeviceAuthorization: async () => {
          throw new Error("use manual key");
        },
        promptConfirm: async () => true,
        promptHidden: async () => (++prompts === 1 ? "" : fake("manual-key")),
      },
    );
    expect(result).toEqual({ kind: "api_key", apiKey: fake("manual-key") });
    expect(prompts).toBe(2);
  });

  test("completes device auth and opens the full verification link when enabled", async () => {
    const oldOpen = process.env.MIRU_OPEN_BROWSER;
    process.env.MIRU_OPEN_BROWSER = "1";
    const opened: string[] = [];
    try {
      const result = await authenticateWithProvider(
        { device: true, interactive: true },
        {
          startDeviceAuthorization: async () => ({
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://verify.test",
            verificationUriComplete: "https://verify.test/CODE",
            expiresIn: 60,
            interval: 0,
          }),
          openBrowser: (url) => {
            opened.push(url);
            return true;
          },
          pollDeviceAuthorization: async () => ({ accessToken: "token", refreshToken: "refresh" }),
        },
      );
      expect(result).toMatchObject({
        kind: "device_code",
        accessToken: "token",
        refreshToken: "refresh",
      });
      expect(opened).toEqual(["https://verify.test/CODE"]);
    } finally {
      if (oldOpen === undefined) delete process.env.MIRU_OPEN_BROWSER;
      else process.env.MIRU_OPEN_BROWSER = oldOpen;
    }
  });

  test("falls back to a manual key when device auth fails and fallback is accepted", async () => {
    const result = await authenticateWithProvider(
      { device: true, interactive: true, allowManualFallback: true, skipValidation: true },
      {
        startDeviceAuthorization: async () => {
          throw new Error("device unavailable");
        },
        promptConfirm: async () => true,
        promptHidden: async () => fake("fallback-key"),
      },
    );
    expect(result).toEqual({ kind: "api_key", apiKey: fake("fallback-key") });
  });

  test("rethrows device auth errors when the manual fallback is declined", async () => {
    await expect(
      authenticateWithProvider(
        { device: true, interactive: true, allowManualFallback: true },
        {
          startDeviceAuthorization: async () => {
            throw new Error("device unavailable");
          },
          promptConfirm: async () => false,
        },
      ),
    ).rejects.toThrow("device unavailable");
  });

  test("does not open the browser for a non-interactive device login and rethrows failures", async () => {
    let opened = false;
    const dependencies = {
      startDeviceAuthorization: async () => ({
        deviceCode: "device",
        userCode: "CODE",
        verificationUri: "https://verify.test",
        expiresIn: 60,
        interval: 0,
      }),
      openBrowser: () => {
        opened = true;
        return true;
      },
      pollDeviceAuthorization: async () => {
        throw "provider failure";
      },
      promptConfirm: async () => false,
    };
    await expect(
      authenticateWithProvider(
        { device: true, interactive: false, allowManualFallback: true },
        dependencies,
      ),
    ).rejects.toBe("provider failure");
    expect(opened).toBe(false);
  });
});
