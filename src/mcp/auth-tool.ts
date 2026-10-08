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
import {
  beginModeSwitch,
  loadStoredCredentials,
  saveStoredCredentials,
  setStoredCredentialsEnvToken,
} from "../credentials.ts";
import {
  parseSageMakerEndpointArn,
  type SageMakerEmbeddingConfig,
  validateSageMakerConnection,
} from "../embeddings/sagemaker.ts";
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
  "Sign in with Takara credentials via device-code login — no terminal required. " +
  "Only call this in direct response to a tool error mentioning missing, expired, rejected, or " +
  "invalid credentials — never speculatively, since it starts a real sign-in prompt for the " +
  "user. Call with no arguments: it opens the device-login page in the user's browser, then " +
  "waits (up to about 45 seconds) for them to approve and returns once they have. If it " +
  'returns "still waiting", tell the user the URL and code and call `auth` again. ' +
  'To switch to a self-hosted AWS SageMaker endpoint instead, call with action "sagemaker" ' +
  "plus `endpoint_arn` and `profile` — only when the user asks for it and gives you both. " +
  "This replaces any stored Takara credentials; signing in with Takara again replaces SageMaker.";

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

/** SageMaker connection check seam so tests need no AWS access. */
export type SageMakerValidator = typeof validateSageMakerConnection;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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
    private readonly validateSageMaker: SageMakerValidator,
  ) {}

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

  /**
   * Switch to a self-hosted SageMaker endpoint, mirroring `miru setup --sagemaker`. Miru only
   * inherits an AWS profile that already exists; it never creates or writes AWS credentials.
   */
  async sagemaker(
    endpointArn: string | undefined,
    profile: string | undefined,
  ): Promise<ToolResult> {
    const arn = endpointArn?.trim();
    const awsProfile = profile?.trim();
    if (!arn || !awsProfile) {
      return toolText(
        'The "sagemaker" action needs both `endpoint_arn` and `profile` (an AWS profile that ' +
          "already exists in ~/.aws). Ask the user for them.",
      );
    }
    const parsed = parseSageMakerEndpointArn(arn);

    // Drop Takara env so validation cannot see a stale mode; a failed validation leaves the
    // stored credentials untouched.
    const previousArn = process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    const previousProfile = process.env.AWS_PROFILE;
    await beginModeSwitch("sagemaker");
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN = arn;
    process.env.AWS_PROFILE = awsProfile;

    const config: SageMakerEmbeddingConfig = {
      endpointName: parsed.endpointName,
      region: parsed.region,
      profile: awsProfile,
      normalize: true,
      truncate: true,
      truncationDirection: "Right",
    };
    const result = await this.validateSageMaker(config);
    if (!result.valid) {
      restoreEnv("MIRU_SAGEMAKER_ENDPOINT_ARN", previousArn);
      restoreEnv("AWS_PROFILE", previousProfile);
      await loadStoredCredentials();
      return toolText(result.message);
    }

    await saveStoredCredentials({ kind: "sagemaker", endpointArn: arn, profile: awsProfile });
    this.pending = null;
    return toolText(
      `Switched to SageMaker endpoint "${parsed.endpointName}" (${parsed.region}, profile ` +
        `"${awsProfile}"). Stored Takara credentials were removed. Miru tools are now ready to use.`,
    );
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
    validateSageMaker?: SageMakerValidator;
  },
): void {
  const state = new AuthToolState(
    options?.openBrowser ?? openBrowserForDeviceLogin,
    options?.waitMs ?? DEFAULT_WAIT_MS,
    options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    options?.validateSageMaker ?? validateSageMakerConnection,
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
            '"start" begins or resumes a device-code login and waits for approval (default); "check" is a single non-blocking poll; "sagemaker" switches to a self-hosted SageMaker endpoint (needs `endpoint_arn` and `profile`).',
          ),
        endpoint_arn: z
          .string()
          .optional()
          .describe('SageMaker endpoint ARN. Only for action "sagemaker".'),
        profile: z
          .string()
          .optional()
          .describe(
            'Name of an AWS profile that already exists in ~/.aws. Only for action "sagemaker".',
          ),
      },
    },
    async ({ action, endpoint_arn: endpointArn, profile }) => {
      try {
        if (action === "sagemaker") {
          return await state.sagemaker(endpointArn, profile);
        }
        return action === "check" ? await state.check() : await state.start();
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
