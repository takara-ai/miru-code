/**
 * Signals that Miru has no usable credentials — missing, expired, or revoked.
 * Callers that can recover (the MCP `auth` tool, `miru setup`) branch on this
 * instead of matching error text.
 */
export class CredentialsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialsError";
  }
}

/** True when `error`, or anything in its `cause` chain, is a CredentialsError. */
export function isCredentialsError(error: unknown): boolean {
  let current: unknown = error;
  // Bounded so a self-referencing cause chain cannot spin forever.
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (current instanceof CredentialsError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
