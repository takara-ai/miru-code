import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BenchmarkSearchTimeoutError,
  grepSearch,
  grepTestUtils,
  parsePathLinePrefix,
  queryKeywords,
  withGrepTimeoutFallback,
} from "../src/benchmark/grep.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Grep benchmark baseline", () => {
  test("covers path and count parser callback edges", () => {
    expect(grepTestUtils.buildGrepPattern([])).toBeNull();
    expect(grepTestUtils.buildGrepPattern(["a.b", "[x]"])).toBe("a\\.b|\\[x\\]");
    expect(grepTestUtils.normalizeRepoFile("/repo", "/repo")).toBe("");
    expect(grepTestUtils.normalizeRepoFile("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(grepTestUtils.normalizeRepoFile("/repo", "src/a.ts")).toBe("src/a.ts");
    expect(grepTestUtils.normalizeRepoFile("/repo", "/other/a.ts")).toBe("/other/a.ts");
    expect(grepTestUtils.normalizeRepoFile("C:/repo", "D:/other/a.ts")).toBe("D:/other/a.ts");
    expect(grepTestUtils.splitSearchToolLine("C:/repo/a.ts:7:hit")).toEqual({
      path: "C:/repo/a.ts",
      rest: "7:hit",
    });
    expect(grepTestUtils.splitSearchToolLine("missing-delimiter")).toBeNull();
    expect(
      grepTestUtils
        .parseCountMatches("/repo", "/repo/a.ts:1\n/repo/b.ts:3\nmalformed\n/repo/bad.ts:nope", 2)
        .map(({ file }) => file),
    ).toEqual(["b.ts", "a.ts"]);
  });

  test("extracts distinct useful query keywords", () => {
    expect(queryKeywords("the auth auth middleware!? x fooBarBaz")).toEqual([
      "middleware",
      "foobarbaz",
      "auth",
    ]);
    expect(queryKeywords("a or to ?? x")).toEqual([]);
    expect(parsePathLinePrefix("src/file.ts:42:const value = 1")).toEqual({
      path: "src/file.ts",
      line: 42,
    });
    expect(parsePathLinePrefix("src/file.ts:42x:malformed")).toBeNull();
    expect(parsePathLinePrefix("src/file.ts:42x")).toBeNull();
    expect(parsePathLinePrefix(`src/file.ts:${"9".repeat(400)}:malformed`)).toBeNull();
  });

  test("searches a local repository and returns ranked snippets", async () => {
    root = await mkdtemp(join(tmpdir(), "miru-grep-"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "auth.ts"),
      ["export function authenticateUser() {", "  return 'auth-token';", "}"].join("\n"),
    );
    await writeFile(join(root, "src", "other.ts"), "export const unrelated = true;\n");
    const result = await grepSearch(root, "authenticate auth", 5);
    expect(result.pattern).toBe("authenticate|auth");
    expect(result.files).toContain("src/auth.ts");
    expect(result.hits.find((hit) => hit.file === "src/auth.ts")?.output).toContain("auth-token");
    expect(result.tokens).toBeGreaterThan(0);
    expect(await grepSearch(root, "to be or", 3)).toMatchObject({
      files: [],
      hits: [],
      tokens: 0,
      pattern: null,
      keywords: [],
    });
  });

  test("exercises rg, grep, and findstr parsers through injected process output", async () => {
    const repo = "/fixture/repo";
    const fakeSpawn =
      (tool: "rg" | "grep" | "findstr", base = repo) =>
      async (args: string[]) => {
        const preview =
          !args.includes("--count-matches") && !args.includes("-R") && args[1] !== "/S";
        if (preview) return `preview from ${tool}\n`;
        if (tool === "rg") return `${repo}/src/a.ts:3\nmalformed\n${repo}/src/b.ts:not-a-count\n`;
        if (tool === "grep")
          return `${repo}/src/a.ts:1:hit\n${repo}/src/a.ts:2:hit\n${repo}/src/b.ts:1:hit\n`;
        return `src/a.ts:4:hit\n${base}/src/b.ts:8:hit\nnode_modules/pkg/a.ts:2:hit\nsrc/odd.ts:5x:nope\nnot-a-path\n`;
      };

    const rg = await grepSearch(repo, "authentication", 5, { tool: "rg", spawn: fakeSpawn("rg") });
    expect(rg.files).toEqual(["src/a.ts"]);
    expect(rg.hits[0]?.output).toContain("preview from rg");

    const grep = await grepSearch(repo, "authentication", 5, {
      tool: "grep",
      spawn: fakeSpawn("grep"),
    });
    expect(grep.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(grep.hits[0]?.output).toContain("preview from grep");

    const winRepo = "C:/fixture/repo";
    const findstr = await grepSearch(winRepo, "authentication", 5, {
      tool: "findstr",
      spawn: fakeSpawn("findstr", winRepo),
    });
    expect(findstr.files).toContain("src/a.ts");
    expect(findstr.files).toContain("src/b.ts");
    expect(findstr.files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(findstr.hits[0]?.output).toContain("preview from findstr");
  });

  test("rejects a forced missing tool but avoids tool selection for empty keywords", async () => {
    await expect(grepSearch("/repo", "authentication", 2, { tool: null })).rejects.toThrow(
      "No search tool found in PATH",
    );
    expect(await grepSearch("/repo", "a or to", 2, { tool: null })).toMatchObject({
      files: [],
      pattern: null,
      keywords: [],
    });
  });

  test("falls back only on benchmark search timeouts", async () => {
    await expect(withGrepTimeoutFallback(async () => 42)).resolves.toBe(42);
    await expect(
      withGrepTimeoutFallback(async () => {
        throw new BenchmarkSearchTimeoutError(2);
      }),
    ).resolves.toBeNull();
    await expect(
      withGrepTimeoutFallback(async () => {
        throw new Error("other failure");
      }),
    ).rejects.toThrow("other failure");
  });

  test("normalizes root, relative, outside, and malformed tool paths", async () => {
    const repo = "/fixture/repo";
    const countOutput = [
      `${repo}:1`,
      `${repo}/src/a.ts:1`,
      "src/relative.ts:2",
      "/outside/file.ts:3",
      "C:/fixture/repo/src/win.ts:4",
      "C:malformed",
      "no-colon",
    ].join("\n");
    const result = await grepSearch(repo, "authentication", 10, {
      tool: "grep",
      spawn: async (args) => {
        if (args.includes("-R")) return countOutput;
        return "preview\n";
      },
    });
    expect(result.files).toContain("");
    expect(result.files).toContain("src/a.ts");
    expect(result.files.some((file) => file.includes("relative.ts"))).toBe(true);
    expect(result.files).toContain("/outside/file.ts");
    expect(result.files).toContain("C:/fixture/repo/src/win.ts");

    const relativeRoot = await grepSearch(".", "authentication", 2, {
      tool: "grep",
      spawn: async (args) =>
        args.includes("-R") ? "src/relative.ts:2:authentication" : "preview\n",
    });
    expect(relativeRoot.files).toContain("src/relative.ts");
  });
});
