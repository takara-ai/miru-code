import { describe, expect, test } from "bun:test";
import {
  batchLiteralPaths,
  buildLiteralArgs,
  parseRgLiteralStats,
  rgLiteralOutput,
} from "../src/benchmark/rg-literal.ts";

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

describe("rgLiteralOutput", () => {
  test("rejects unsupported comparable command construction", () => {
    expect(() => buildLiteralArgs("findstr", "/repo", ["needle"], 0, 20, false)).toThrow(
      "Unsupported comparable literal benchmark tool: findstr",
    );
  });

  test("builds ripgrep arguments, batches long path lists, and combines output", async () => {
    const root = "/repo";
    const calls: string[][] = [];
    const paths = ["a".repeat(3000), "b".repeat(3000)];
    const result = await rgLiteralOutput(
      root,
      ["alpha", "beta"],
      {
        context: 2,
        maxCount: 3,
        ignoreCase: true,
        include: ["src/**"],
        exclude: ["*.test.ts"],
        paths,
      },
      {
        tool: "rg",
        spawn: async (args) => {
          calls.push(args);
          return `${root}/src/a.ts:2:alpha\n`;
        },
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("-F");
    expect(calls[0]).toContain("-i");
    expect(calls[0]).toContain("-C");
    expect(calls[0]).toContain("src/**");
    expect(calls[0]).toContain("!*.test.ts");
    expect(calls[0]).toContain("alpha");
    expect(calls[0]).toContain("beta");
    expect(result).toMatchObject({ n: 2, files: 1 });
    expect(result.text).toContain("alpha");
    expect(batchLiteralPaths([])).toEqual([]);
  });

  test("builds grep count arguments and ignores invalid or external count rows", async () => {
    const calls: string[][] = [];
    const result = await rgLiteralOutput(
      "/repo",
      "needle",
      {
        context: 1,
        maxCount: 4,
        ignoreCase: true,
        countOnly: true,
        include: ["*.ts"],
        exclude: ["vendor/**"],
      },
      {
        tool: "grep",
        spawn: async (args) => {
          calls.push(args);
          return "/repo/a.ts:2\n/repo/b.ts:0\n/repo/c.ts:nope\n/outside.ts:7\nmalformed\n";
        },
      },
    );
    expect(calls[0]).toContain("-R");
    expect(calls[0]).toContain("-c");
    expect(calls[0]).toContain("--include=*.ts");
    expect(calls[0]).toContain("--exclude=vendor/**");
    expect(calls[0]).toContain("-m");
    expect(result).toMatchObject({ n: 2, files: 1 });
  });

  test("rejects unsupported baseline tools before spawning", async () => {
    let spawned = false;
    await expect(
      rgLiteralOutput(
        "/repo",
        "needle",
        {},
        {
          tool: null,
          spawn: async () => {
            spawned = true;
            return "";
          },
        },
      ),
    ).rejects.toThrow("requires rg or compatible grep");
    expect(spawned).toBe(false);
  });
});
