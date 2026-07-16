import { describe, expect, test } from "bun:test";
import { parseRgLiteralStats } from "../src/benchmark/rg-literal.ts";

describe("parseRgLiteralStats edge cases", () => {
  test("parses unix match and context lines", () => {
    const text = [
      "/repo/src/a.ts:10:const DATABASE_URL = process.env.DATABASE_URL;",
      "/repo/src/a.ts-11-function read() {",
      "--",
      "/repo/src/b.ts:4:const DATABASE_URL = 'x';",
      "",
    ].join("\n");

    expect(parseRgLiteralStats(text, "/repo")).toEqual({ n: 2, files: 2 });
  });

  test("parses windows drive-letter paths correctly", () => {
    const text = [
      "C:\\repo\\src\\a.ts:10:const DATABASE_URL = process.env.DATABASE_URL;",
      "C:\\repo\\src\\a.ts-11-function read() {",
      "C:\\repo\\src\\b.ts:4:const DATABASE_URL = 'x';",
      "",
    ].join("\n");

    expect(parseRgLiteralStats(text, "C:\\repo")).toEqual({ n: 2, files: 2 });
  });

  test("ignores malformed and non-location lines", () => {
    const text = [
      "Executable not found in $PATH: rg",
      "just some text",
      "/repo/src/a.ts:abc:not-a-line-number",
      "",
    ].join("\n");

    expect(parseRgLiteralStats(text, "/repo")).toEqual({ n: 0, files: 0 });
  });
});
