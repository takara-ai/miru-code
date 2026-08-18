import { describe, expect, test } from "bun:test";
import { CredentialsError, isCredentialsError } from "../src/auth/errors.ts";
import { toolErrorText } from "../src/mcp/auth-tool.ts";

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("credentials error recognition", () => {
  test("isCredentialsError is true for a direct CredentialsError", () => {
    expect(isCredentialsError(new CredentialsError("no key"))).toBe(true);
  });

  test("isCredentialsError follows the cause chain", () => {
    const wrapped = new Error("Failed to index /repo: boom", {
      cause: new CredentialsError("Device token refresh failed: invalid_grant"),
    });
    expect(isCredentialsError(wrapped)).toBe(true);
  });

  test("isCredentialsError is false for an unrelated error", () => {
    expect(isCredentialsError(new Error("network down"))).toBe(false);
    expect(isCredentialsError("plain string")).toBe(false);
  });
});

describe("toolErrorText", () => {
  test("appends the auth recovery step for credentials failures", () => {
    const text = textOf(toolErrorText(new CredentialsError("Device token refresh failed")));
    expect(text).toContain("Device token refresh failed");
    expect(text).toContain("`auth`");
    expect(text).toContain('action "start"');
    // The host tool cannot sign in to Takara, so it must never be suggested.
    expect(text).not.toContain("mcp_auth");
  });

  test("credentials failures wrapped by the index layer still recover", () => {
    const wrapped = new Error("Failed to index /repo: nope", {
      cause: new CredentialsError("Takara credentials required."),
    });
    const text = textOf(toolErrorText(wrapped));
    expect(text).toContain("Failed to index /repo");
    expect(text).toContain("Miru is not signed in");
  });

  test("plain errors pass through unchanged", () => {
    const text = textOf(toolErrorText(new Error("No results found.")));
    expect(text).toBe("No results found.");
  });
});
