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
  "Only call this in direct response to a tool error mentioning missing/expired " +
  "credentials — never speculatively, since it starts a real sign-in prompt for the " +
  'user. Call with no arguments (or action "start") to begin: it returns a URL and a ' +
  "short code. Show both to the user and ask them to open the link and approve. Once " +
  'they confirm, call again with action "check" to complete sign-in.';

type PendingDeviceAuth = {
  start: DeviceAuthorizationStart;
  config: DeviceAuthConfig;
  startedAtMs: number;
};

function isExpired(entry: Pick<PendingDeviceAuth, "start" | "startedAtMs">): boolean {
  return Date.now() >= entry.startedAtMs + entry.start.expiresIn * 1000;
}

/**
 * Per-registration auth-tool state, scoped to one `registerAuthTool` call rather than
 * the module — a process could in principle host more than one MiruMcpServer (tests
 * already do), and a module-level singleton would let their device logins collide.
 */
class AuthToolState {
  private pending: PendingDeviceAuth | null = null;

  async start(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (this.pending && !isExpired(this.pending)) {
      const { userCode, verificationUriComplete, verificationUri } = this.pending.start;
      return toolText(
        `A device login is already pending. Open ${verificationUriComplete ?? verificationUri} ` +
          `and enter code ${userCode} if not already filled in, then call \`auth\` again with ` +
          'action "check" once approved.',
      );
    }
    this.pending = null;

    const config = resolveDeviceAuthConfig();
    const start = await startDeviceAuthorization({ config });
    this.pending = { start, config, startedAtMs: Date.now() };

    const link = start.verificationUriComplete ?? start.verificationUri;
    return toolText(
      `Open ${link} and approve the request` +
        (start.verificationUriComplete ? "." : ` (enter code ${start.userCode} if prompted).`) +
        ` Code: ${start.userCode}. Once the user confirms they've approved it, call \`auth\` again ` +
        'with action "check" to finish signing in.',
    );
  }

  async check(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.pending) {
      return toolText('No device login is pending. Call `auth` with action "start" first.');
    }

    const { start, config } = this.pending;
    // Errors (network failure, unrecognized OAuth error code) intentionally leave
    // `pending` intact — a transient failure shouldn't force the user to restart
    // the whole login, just retry the check.
    const result = await checkDeviceAuthorizationOnce(start, { config });

    switch (result.status) {
      case "success": {
        this.pending = null;
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
        this.pending = null;
        return toolText('Sign-in was denied. Call `auth` with action "start" to try again.');
      case "expired":
        this.pending = null;
        return toolText(
          'The device code expired before it was approved. Call `auth` with action "start" to try again.',
        );
    }
  }
}

export function registerAuthTool(server: MiruMcpServer): void {
  const state = new AuthToolState();

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
        return action === "check" ? await state.check() : await state.start();
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
