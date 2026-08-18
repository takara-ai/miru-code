import * as z from "zod";
import {
  checkDeviceAuthorizationOnce,
  type DeviceAuthConfig,
  type DeviceAuthorizationStart,
  openBrowserForDeviceLogin,
  resolveDeviceAuthConfig,
  startDeviceAuthorization,
} from "../auth/device.ts";
import { isCredentialsError } from "../auth/errors.ts";
import { saveStoredCredentials, setStoredCredentialsEnvToken } from "../credentials.ts";
import { toolText } from "./index-cache.ts";
import type { MiruMcpServer } from "./runtime.ts";

type ToolResult = ReturnType<typeof toolText>;

const CHECK_HINT =
  'Once the user approves, call `auth` again with action "check" to finish signing in.';

/** Appended to credentials failures so an agent knows Miru's own recovery step. */
const RECOVERY_HINT =
  'Miru could not authorize its current credentials. Call the `auth` tool with action "start" ' +
  'to open the Takara device-login page, then action "check" once the user approves. If access ' +
  "is still denied after signing in, check the account token balance.";

const AUTH_TOOL_DESCRIPTION =
  "Sign in with Takara credentials via device-code login — no terminal required. " +
  "Only call this in direct response to a tool error mentioning missing, expired, rejected, or " +
  "invalid credentials — never speculatively, since it starts a real sign-in prompt for the " +
  'user. Call with no arguments (or action "start") to begin: it opens the device-login ' +
  `page in the user's browser and returns that URL plus a short code. ${CHECK_HINT}`;

/** Browser opener seam; the real one spawns a detached `open`/`xdg-open`/`start`. */
export type BrowserOpener = (url: string) => boolean;

/** Opening is on unless MIRU_OPEN_BROWSER is set to something other than "1" (matches `miru setup`). */
function openIfAllowed(open: BrowserOpener, url: string): boolean {
  const raw = process.env.MIRU_OPEN_BROWSER;
  if (raw !== undefined && raw !== "1") {
    return false;
  }
  return open(url);
}

function approvalText(link: string, userCode: string, opened: boolean): string {
  const lead = opened ? `A browser tab is open at ${link}` : `Ask the user to open ${link}`;
  return `${lead}. Code: ${userCode}. ${CHECK_HINT}`;
}

/** Tool-failure text for every Miru tool, with the sign-in step added when relevant. */
export function toolErrorText(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return toolText(isCredentialsError(err) ? `${message}\n\n${RECOVERY_HINT}` : message);
}

type PendingDeviceAuth = {
  start: DeviceAuthorizationStart;
  config: DeviceAuthConfig;
  startedAtMs: number;
};

function isExpired(entry: PendingDeviceAuth): boolean {
  return Date.now() >= entry.startedAtMs + entry.start.expiresIn * 1000;
}

/**
 * Per-registration auth-tool state, scoped to one `registerAuthTool` call rather than
 * the module — a process could in principle host more than one MiruMcpServer (tests
 * already do), and a module-level singleton would let their device logins collide.
 */
class AuthToolState {
  private pending: PendingDeviceAuth | null = null;

  constructor(private readonly openBrowser: BrowserOpener) {}

  async start(): Promise<ToolResult> {
    let pending = this.pending;
    if (!pending || isExpired(pending)) {
      const config = resolveDeviceAuthConfig();
      const start = await startDeviceAuthorization({ config });
      pending = { start, config, startedAtMs: Date.now() };
      this.pending = pending;
    }

    const { verificationUriComplete, verificationUri, userCode } = pending.start;
    const link = verificationUriComplete ?? verificationUri;
    // Reopening on a repeat call is deliberate: the user may have closed the first tab.
    return toolText(approvalText(link, userCode, openIfAllowed(this.openBrowser, link)));
  }

  async check(): Promise<ToolResult> {
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

export function registerAuthTool(
  server: MiruMcpServer,
  options?: { openBrowser?: BrowserOpener },
): void {
  const state = new AuthToolState(options?.openBrowser ?? openBrowserForDeviceLogin);

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
