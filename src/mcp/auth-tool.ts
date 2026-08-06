import * as z from "zod";
import {
  checkDeviceAuthorizationOnce,
  type DeviceAuthConfig,
  type DeviceAuthorizationStart,
  resolveDeviceAuthConfig,
  startDeviceAuthorization,
} from "../auth/device.ts";
import { saveStoredCredentials, setStoredCredentialsEnvToken } from "../credentials.ts";
import { toolText } from "./index-cache.ts";
import type { MiruMcpServer } from "./runtime.ts";

const AUTH_TOOL_DESCRIPTION =
  "Sign in with Takara credentials via device-code login — no terminal required. " +
  'Call with no arguments (or action "start") to begin: it returns a URL and a short code. ' +
  "Show both to the user and ask them to open the link and approve. Once they confirm, " +
  'call again with action "check" to complete sign-in.';

/** Single pending device-code login per MCP server process — one user, one session. */
let pending: {
  start: DeviceAuthorizationStart;
  config: DeviceAuthConfig;
  startedAtMs: number;
} | null = null;

function isExpired(entry: { start: DeviceAuthorizationStart; startedAtMs: number }): boolean {
  return Date.now() >= entry.startedAtMs + entry.start.expiresIn * 1000;
}

async function handleStart(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (pending && !isExpired(pending)) {
    const { userCode, verificationUriComplete, verificationUri } = pending.start;
    return toolText(
      `A device login is already pending. Open ${verificationUriComplete ?? verificationUri} ` +
        `and enter code ${userCode} if not already filled in, then call \`auth\` again with ` +
        'action "check" once approved.',
    );
  }
  pending = null;

  const config = resolveDeviceAuthConfig();
  const start = await startDeviceAuthorization({ config });
  pending = { start, config, startedAtMs: Date.now() };

  const link = start.verificationUriComplete ?? start.verificationUri;
  return toolText(
    `Open ${link} and approve the request` +
      (start.verificationUriComplete ? "." : ` (enter code ${start.userCode} if prompted).`) +
      ` Code: ${start.userCode}. Once the user confirms they've approved it, call \`auth\` again ` +
      'with action "check" to finish signing in.',
  );
}

async function handleCheck(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!pending) {
    return toolText('No device login is pending. Call `auth` with action "start" first.');
  }

  const { start, config } = pending;
  const result = await checkDeviceAuthorizationOnce(start, { config });

  switch (result.status) {
    case "success": {
      pending = null;
      const { tokens } = result;
      await saveStoredCredentials({
        kind: "device_code",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
      });
      setStoredCredentialsEnvToken(tokens.accessToken);
      return toolText("Signed in successfully. Miru tools are now ready to use.");
    }
    case "pending":
      return toolText(
        'Still waiting for approval. Ask the user to confirm they clicked and approved, then call `auth` again with action "check".',
      );
    case "slow_down":
      return toolText(
        'Checking too soon — wait a bit before calling `auth` again with action "check".',
      );
    case "denied":
      pending = null;
      return toolText('Sign-in was denied. Call `auth` with action "start" to try again.');
    case "expired":
      pending = null;
      return toolText(
        'The device code expired before it was approved. Call `auth` with action "start" to try again.',
      );
  }
}

/** Test-only: clear in-process pending state between test cases. */
export function __resetAuthToolStateForTests(): void {
  pending = null;
}

export function registerAuthTool(server: MiruMcpServer): void {
  server.registerTool(
    "auth",
    {
      description: AUTH_TOOL_DESCRIPTION,
      inputSchema: {
        action: z
          .enum(["start", "check"])
          .optional()
          .describe('"start" begins a device-code login (default); "check" completes it.'),
      },
    },
    async ({ action }) => {
      try {
        return action === "check" ? await handleCheck() : await handleStart();
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
