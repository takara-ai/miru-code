import * as z from "zod";
import {
  checkDeviceAuthorizationOnce,
  type DeviceAuthConfig,
  type DeviceAuthorizationCheck,
  type DeviceAuthorizationStart,
  openBrowserForDeviceLogin,
  resolveDeviceAuthConfig,
  startDeviceAuthorization,
} from "../auth/device.ts";
import { isCredentialsError } from "../auth/errors.ts";
import { saveStoredCredentials, setStoredCredentialsEnvToken } from "../credentials.ts";
import { parseSageMakerEndpointArn, validateSageMakerConnection } from "../embeddings/sagemaker.ts";
import { toolText } from "./index-cache.ts";
import type { MiruMcpServer } from "./runtime.ts";

type ToolResult = ReturnType<typeof toolText>;

const CHECK_HINT =
  "If the user has not approved yet, call `auth` again to keep waiting; it will not open a second tab.";

/**
 * How long one `auth` call waits for the user to approve in the browser. Kept well under
 * typical MCP client tool timeouts; a slower login just takes another call.
 */
const DEFAULT_WAIT_MS = 45_000;
const SLOW_DOWN_STEP_MS = 5_000;
/** The server may advertise `interval: 0`; never poll the token endpoint faster than this. */
const MIN_POLL_INTERVAL_MS = 1_000;

/** Appended to credentials failures so an agent knows Miru's own recovery step. */
const RECOVERY_HINT =
  "Miru could not authorize its current credentials. Call the `auth` tool to open the Takara " +
  "device-login page; it waits for the user to approve. If access is still denied after " +
  "signing in, check the account token balance.";

const AUTH_TOOL_DESCRIPTION =
  'Configure Miru authentication. On explicit user request, use action "sagemaker" with ' +
  "endpoint_arn and aws_profile to validate and save a SageMaker endpoint, replacing stored credentials. " +
  "Otherwise, sign in with Takara device-code login. Only start device login in direct response to a tool error about " +
  "missing, expired, rejected, or invalid credentials — never speculatively: it starts a real " +
  "sign-in prompt. No arguments: opens the login page in the user's browser and waits up to ~45s " +
  'for approval. If it returns "still waiting", tell the user the URL and code and call `auth` again.';

/** Browser opener seam; the real one spawns a detached `open`/`xdg-open`/`start`. */
export type BrowserOpener = (url: string) => boolean;

/** Sleep seam so tests can drive the wait loop without real delays. */
export type Sleeper = (ms: number) => Promise<void>;

/** Opening is on unless MIRU_OPEN_BROWSER is set to something other than "1" (matches `miru setup`). */
function openIfAllowed(open: BrowserOpener, url: string): boolean {
  const raw = process.env.MIRU_OPEN_BROWSER;
  if (raw !== undefined && raw !== "1") {
    return false;
  }
  return open(url);
}

/** `opened` is null when resuming an existing login (no new tab was opened). */
function approvalText(link: string, userCode: string, opened: boolean | null): string {
  const lead =
    opened === null
      ? `Still waiting for approval at ${link}`
      : opened
        ? `A browser tab is open at ${link}`
        : `Ask the user to open ${link}`;
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

  constructor(
    private readonly openBrowser: BrowserOpener,
    private readonly waitMs: number,
    private readonly sleep: Sleeper,
    private readonly onAuthenticated?: () => void,
    private readonly validateConnection = validateSageMakerConnection,
  ) {}

  async configureSageMaker(endpointArn: string, profile: string) {
    const pluginArn = process.env.MIRU_PLUGIN_SAGEMAKER_ENDPOINT_ARN?.trim();
    if (pluginArn && !(pluginArn.startsWith("${") && pluginArn.endsWith("}"))) {
      throw new Error(
        "SageMaker is controlled by this host's plugin settings. " +
          "Change or clear the endpoint ARN and AWS profile there first.",
      );
    }
    const { endpointName, region } = parseSageMakerEndpointArn(endpointArn);
    const result = await this.validateConnection({
      endpointName,
      region,
      profile,
      normalize: true,
      truncate: true,
      truncationDirection: "Right",
    });
    if (!result.valid) {
      return { ...toolText(result.message), isError: true };
    }
    await saveStoredCredentials({ kind: "sagemaker", endpointArn, profile });
    this.pending = null;
    this.onAuthenticated?.();
    return toolText(
      `Miru now embeds via SageMaker endpoint ${endpointName} in ${region} ` +
        `(AWS profile: ${profile}). Configuration saved for this plugin. ` +
        "The index will reload on the next search.",
    );
  }

  async start(): Promise<ToolResult> {
    let pending = this.pending;
    let fresh = false;
    if (!pending || isExpired(pending)) {
      fresh = true;
      const config = resolveDeviceAuthConfig();
      const start = await startDeviceAuthorization({ config });
      pending = { start, config, startedAtMs: Date.now() };
      this.pending = pending;
    }

    const { verificationUriComplete, verificationUri, userCode } = pending.start;
    const link = verificationUriComplete ?? verificationUri;
    // Only a new login opens a tab; a repeat call just resumes the wait.
    const opened = fresh ? openIfAllowed(this.openBrowser, link) : null;

    const settled = await this.waitForApproval(pending);
    return settled ?? toolText(approvalText(link, userCode, opened));
  }

  /** Poll until approved, denied or expired, or the wait budget runs out (then null). */
  private async waitForApproval(entry: PendingDeviceAuth): Promise<ToolResult | null> {
    const deadline = Date.now() + this.waitMs;
    let intervalMs = Math.max(entry.start.interval * 1000, MIN_POLL_INTERVAL_MS);
    while (Date.now() + intervalMs <= deadline) {
      await this.sleep(intervalMs);
      const result = await checkDeviceAuthorizationOnce(entry.start, { config: entry.config });
      const settled = await this.settle(result);
      if (settled) {
        return settled;
      }
      if (result.status === "slow_down") {
        intervalMs += SLOW_DOWN_STEP_MS;
      }
    }
    return null;
  }

  /** Handle a final poll result; null means the login is still pending. */
  private async settle(result: DeviceAuthorizationCheck): Promise<ToolResult | null> {
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
        this.onAuthenticated?.();
        return toolText("Signed in successfully. Miru tools are now ready to use.");
      }
      case "denied":
        this.pending = null;
        return toolText("Sign-in was denied. Call `auth` again to try again.");
      case "expired":
        this.pending = null;
        return toolText(
          "The device code expired before it was approved. Call `auth` again to get a new one.",
        );
      default:
        return null;
    }
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

    const settled = await this.settle(result);
    if (settled) {
      return settled;
    }
    return toolText(
      result.status === "slow_down"
        ? "Checking too soon — wait a bit before calling `auth` again."
        : "Still waiting for approval. Ask the user to confirm they clicked and approved, then call `auth` again.",
    );
  }
}

export function registerAuthTool(
  server: MiruMcpServer,
  options?: {
    openBrowser?: BrowserOpener;
    waitMs?: number;
    sleep?: Sleeper;
    onAuthenticated?: () => void;
    validateConnection?: typeof validateSageMakerConnection;
  },
): void {
  const state = new AuthToolState(
    options?.openBrowser ?? openBrowserForDeviceLogin,
    options?.waitMs ?? DEFAULT_WAIT_MS,
    options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    options?.onAuthenticated,
    options?.validateConnection,
  );

  server.registerTool(
    "auth",
    {
      description: AUTH_TOOL_DESCRIPTION,
      inputSchema: {
        action: z
          .enum(["start", "check", "sagemaker"])
          .optional()
          .describe(
            '"start" begins/resumes login and waits for approval (default); "check" polls once; "sagemaker" validates and saves endpoint_arn and aws_profile.',
          ),
        endpoint_arn: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Required for action sagemaker."),
        aws_profile: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing AWS profile; required for action sagemaker."),
      },
    },
    async ({ action, endpoint_arn, aws_profile }) => {
      try {
        if (action === "sagemaker") {
          if (!endpoint_arn || !aws_profile) {
            throw new Error('Action "sagemaker" requires endpoint_arn and aws_profile.');
          }
          return await state.configureSageMaker(endpoint_arn, aws_profile);
        }
        if (endpoint_arn !== undefined || aws_profile !== undefined) {
          throw new Error('Use action "sagemaker" with endpoint_arn and aws_profile.');
        }
        return action === "check" ? await state.check() : await state.start();
      } catch (err) {
        return { ...toolText(err instanceof Error ? err.message : String(err)), isError: true };
      }
    },
  );
}
