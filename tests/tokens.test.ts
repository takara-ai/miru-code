import { describe, expect, test } from "bun:test";
import { splitIdentifier, tokenize } from "../src/tokens.ts";

describe("tokens", () => {
  test("splitIdentifier camelCase", () => {
    expect(splitIdentifier("HandlerStack")).toEqual(["handlerstack", "handler", "stack"]);
  });

  test("splitIdentifier snake_case", () => {
    expect(splitIdentifier("my_func")).toEqual(["my_func", "my", "func"]);
  });

  test("tokenize expands compounds", () => {
    const tokens = tokenize("getHTTPResponse");
    expect(tokens).toContain("gethttpresponse");
    expect(tokens).toContain("http");
  });
});
