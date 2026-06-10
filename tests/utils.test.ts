import { describe, expect, test } from "bun:test";
import { findIndexCachePath } from "../src/cache.ts";
import { detectLanguage } from "../src/index/files.ts";
import type { Chunk } from "../src/types.ts";
import {
  clampMcpTopK,
  dedupeResultsByFile,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  isAllowedRepoSource,
  isGitUrl,
  localRepoRoot,
  MAX_MCP_TOP_K,
  resolveChunk,
  resolveSearchPath,
  toIndexedFilePath,
} from "../src/utils.ts";

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

  test("resolveChunk accepts absolute paths when repo root is known", () => {
    const repoRoot = "/tmp/miru-repo";
    const hit = chunk("x = 1", "src/a.py", 1, 1);
    const absolute = `${repoRoot}/src/a.py`;

    expect(resolveChunk([hit], absolute, 1, repoRoot)).toBe(hit);
    expect(resolveChunk([hit], "src/a.py", 1, repoRoot)).toBe(hit);
  });

  test("toIndexedFilePath normalizes absolute and relative paths", () => {
    const repoRoot = "/tmp/miru-repo";
    expect(toIndexedFilePath("src/a.py", repoRoot)).toBe("src/a.py");
    expect(toIndexedFilePath(`${repoRoot}/src/a.py`, repoRoot)).toBe("src/a.py");
    expect(toIndexedFilePath("src/a.py")).toBe("src/a.py");
  });

  test("localRepoRoot resolves local paths and rejects git URLs", () => {
    expect(localRepoRoot("https://github.com/org/repo")?.includes("github")).toBeFalsy();
    expect(localRepoRoot("https://github.com/org/repo")).toBeNull();
    expect(localRepoRoot("/tmp/repo")?.endsWith("/tmp/repo")).toBe(true);
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
      score: "100%",
      chunk: {
        file_path: "f.py",
        location: "f.py:1-1",
      },
    });
  });

  test("formatResults adds absolute_path for local repo roots", () => {
    const c = chunk("def fn(): pass", "src/f.py", 1, 1);
    const out = formatResults("foo", [{ chunk: c, score: 0.5 }], {
      repoRoot: "/tmp/miru-repo",
    });
    expect(out.results[0]).toMatchObject({
      score: "100%",
      chunk: {
        file_path: "src/f.py",
        absolute_path: "/tmp/miru-repo/src/f.py",
        location: "/tmp/miru-repo/src/f.py:1-1",
      },
    });
  });

  test("clampMcpTopK defaults and caps excessive values", () => {
    expect(clampMcpTopK()).toBe(3);
    expect(clampMcpTopK(5)).toBe(5);
    expect(clampMcpTopK(200)).toBe(MAX_MCP_TOP_K);
    expect(clampMcpTopK(0)).toBe(3);
  });

  test("formatResults omits guidance", () => {
    const hit = chunk("def render(): pass\n" + "x = 1\n".repeat(20), "src/a.py", 1, 22);
    const out = formatResults("why does render fail", [{ chunk: hit, score: 0.9 }]);
    expect(out).not.toHaveProperty("guidance");
    expect(out.results).toHaveLength(1);
  });

  test("dedupeResultsByFile keeps best score per file", () => {
    const a1 = chunk("a1", "src/a.py", 1, 1);
    const a2 = chunk("a2", "src/a.py", 2, 2);
    const b = chunk("b", "src/b.py", 1, 1);
    const out = dedupeResultsByFile([
      { chunk: a1, score: 0.2 },
      { chunk: b, score: 0.9 },
      { chunk: a2, score: 0.8 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.chunk.file_path).toBe("src/b.py");
    expect(out[1]?.chunk.content).toBe("a2");
  });

  test("expandChunksAtLine returns adjacent chunks in file order", () => {
    const c1 = chunk("one", "src/a.py", 1, 5);
    const c2 = chunk("two", "src/a.py", 6, 10);
    const c3 = chunk("three", "src/a.py", 11, 15);
    const { anchor, chunks: expanded } = expandChunksAtLine(
      [c1, c2, c3],
      "src/a.py",
      7,
      null,
      1,
      1,
    );
    expect(anchor).toBe(c2);
    expect(expanded.map((c) => c.content)).toEqual(["one", "two", "three"]);
  });

  test("formatExpandResults returns chunk payloads", () => {
    const c1 = chunk("one", "src/a.py", 1, 5);
    const c2 = chunk("two", "src/a.py", 6, 10);
    const out = formatExpandResults("src/a.py", 7, c2, [c1, c2], {
      repoRoot: "/tmp/miru-repo",
      before: 1,
      after: 0,
    });
    expect(out.chunk_count).toBe(2);
    expect(out).not.toHaveProperty("guidance");
    expect(out.chunks).toHaveLength(2);
  });
});
