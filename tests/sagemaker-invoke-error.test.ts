import { describe, expect, test } from "bun:test";
import {
  SAGEMAKER_AUTH_ERROR_MESSAGE,
  SAGEMAKER_NOT_FOUND_ERROR_MESSAGE,
  SAGEMAKER_UNREACHABLE_ERROR_MESSAGE,
  toInvokeError,
} from "../src/embeddings/sagemaker.ts";

describe("toInvokeError", () => {
  test("auth exceptions map to the auth error message", () => {
    const err = toInvokeError({ name: "AccessDeniedException", message: "denied" });
    expect(err.status).toBe(403);
    expect(err.message).toBe(SAGEMAKER_AUTH_ERROR_MESSAGE);
  });

  test("ValidationError with 'not found' maps to the not-found message", () => {
    const err = toInvokeError({
      name: "ValidationError",
      message: "Endpoint my-endpoint of account 123456789012 not found.",
    });
    expect(err.status).toBe(404);
    expect(err.message).toBe(SAGEMAKER_NOT_FOUND_ERROR_MESSAGE);
  });

  test("ValidationError without 'not found' falls through to the generic message", () => {
    const err = toInvokeError({
      name: "ValidationError",
      message: "1 validation error detected: bad request shape",
      $metadata: { httpStatusCode: 400 },
    });
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad request shape");
    expect(err.message).not.toBe(SAGEMAKER_NOT_FOUND_ERROR_MESSAGE);
  });

  test("DNS/connection error codes map to the unreachable message", () => {
    const err = toInvokeError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" });
    expect(err.status).toBe(503);
    expect(err.message).toBe(SAGEMAKER_UNREACHABLE_ERROR_MESSAGE);
  });

  test("connection error codes nested under cause also map to the unreachable message", () => {
    const err = toInvokeError({
      message: "fetch failed",
      cause: { code: "ECONNREFUSED" },
    });
    expect(err.status).toBe(503);
    expect(err.message).toBe(SAGEMAKER_UNREACHABLE_ERROR_MESSAGE);
  });
});
