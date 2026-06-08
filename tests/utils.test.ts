import { describe, expect, test } from "bun:test";
import type { Chunk } from "../src/types.ts";
import {
  formatResults,
  isAllowedRepoSource,
  isGitUrl,
  resolveChunk,
  resolveSearchPath,
} from "../src/utils.ts";
import { detectLanguage } from "../src/index/files.ts";
import { findIndexCachePath } from "../src/cache.ts";

function chunk(content: string, filePath: string, start: number, end: number): Chunk {
  return {
    content,
    file_path: filePath,
    start_line: start,
    end_line: end,
    language: "python",
  };
}

describe("utils", () => {
  test("resolveChunk handles interior, boundary, and miss cases", () => {
    const interior = chunk("line1\nline2\nline3", "src/a.py", 1, 3);
    const boundary = chunk("last line", "src/a.py", 1, 1);

    expect(resolveChunk([interior], "src/a.py", 2)).toBe(interior);
    expect(resolveChunk([boundary], "src/a.py", 1)).toBe(boundary);
    expect(resolveChunk([interior], "src/other.py", 1)).toBeNull();
    expect(resolveChunk([interior], "src/a.py", 99)).toBeNull();
  });

  test("isGitUrl detects remote URLs and not local paths", () => {
    expect(isGitUrl("https://github.com/org/repo")).toBe(true);
    expect(isGitUrl("git@github.com:org/repo")).toBe(true);
    expect(isGitUrl("/local/path")).toBe(false);
    expect(isGitUrl("./relative")).toBe(false);
  });

  test("resolveSearchPath leaves git URLs unchanged", () => {
    const url = "https://github.com/fmtlib/fmt";
    expect(resolveSearchPath(url)).toBe(url);
    expect(resolveSearchPath("/tmp/repo").endsWith("/tmp/repo")).toBe(true);
  });

  test("findIndexCachePath hashes git URLs without filesystem resolve", () => {
    const url = "https://github.com/fmtlib/fmt";
    const path = findIndexCachePath(url);
    expect(path).toContain("index");
    expect(path).not.toContain("https:");
    expect(findIndexCachePath(url)).toBe(path);
  });

  test("detectLanguage maps C++ headers to cpp", () => {
    expect(detectLanguage("include/fmt/chrono.h")).toBe("cpp");
    expect(detectLanguage("src/main.c")).toBe("c");
    expect(detectLanguage("src/main.cpp")).toBe("cpp");
  });

  test("isAllowedRepoSource rejects non-http git transports for MCP", () => {
    expect(isAllowedRepoSource("https://github.com/org/repo")).toBe(true);
    expect(isAllowedRepoSource("/tmp/repo")).toBe(true);
    expect(isAllowedRepoSource("git@github.com:org/repo")).toBe(false);
  });

  test("formatResults matches Python JSON shape", () => {
    const c = chunk("def fn(): pass", "f.py", 1, 1);
    const out = formatResults("foo", [{ chunk: c, score: 0.5 }]);
    expect(out.query).toBe("foo");
    expect(out.results[0]).toMatchObject({
      score: 0.5,
      chunk: {
        file_path: "f.py",
        location: "f.py:1-1",
      },
    });
  });
});
