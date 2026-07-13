import { describe, expect, test } from "bun:test";
import { formatLiteralLocate, locateLiteral } from "../src/literal.ts";
import type { Chunk } from "../src/types.ts";

const chunks: Chunk[] = [
  {
    file_path: "src/a.ts",
    start_line: 10,
    end_line: 12,
    language: "typescript",
    content: "const FOO = 1;\nexport const BAR = FOO;\n// end",
  },
  {
    file_path: "src/a.ts",
    start_line: 11,
    end_line: 13,
    language: "typescript",
    // Overlaps previous chunk — FOO on line 11 should dedupe
    content: "export const BAR = FOO;\n// end\nconst Z = 0;",
  },
  {
    file_path: "src/b.ts",
    start_line: 1,
    end_line: 2,
    language: "typescript",
    content: "import { FOO } from './a';\nconsole.log(foo);",
  },
];

describe("locateLiteral", () => {
  test("finds exact matches with line text and dedupes overlapping chunks", () => {
    const result = locateLiteral(chunks, "FOO", { mode: "lines" });
    expect(result.n).toBe(3);
    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.hits).toEqual([
      { file_path: "src/a.ts", line: 10, text: "const FOO = 1;" },
      { file_path: "src/a.ts", line: 11, text: "export const BAR = FOO;" },
      { file_path: "src/b.ts", line: 1, text: "import { FOO } from './a';" },
    ]);
  });

  test("returns all hits by default with no truncation", () => {
    const result = locateLiteral(chunks, "FOO", { mode: "locations" });
    expect(result.n).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(3);
    expect(formatLiteralLocate(result).truncated).toBeUndefined();
  });

  test("optional limit truncates and marks truncated", () => {
    const result = locateLiteral(chunks, "FOO", { mode: "locations", limit: 2 });
    expect(result.n).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.hits).toEqual([
      { file_path: "src/a.ts", line: 10 },
      { file_path: "src/a.ts", line: 11 },
    ]);
    expect(formatLiteralLocate(result).truncated).toBe(true);
  });

  test("count mode returns totals only", () => {
    const result = locateLiteral(chunks, "FOO", { mode: "count" });
    expect(result).toEqual({
      literal: "FOO",
      mode: "count",
      n: 3,
      files: 2,
      truncated: false,
      hits: [],
    });
  });

  test("ignore_case matches differently cased lines", () => {
    const result = locateLiteral(chunks, "foo", { mode: "locations", ignore_case: true });
    expect(result.n).toBe(4);
    expect(result.hits.some((h) => h.file_path === "src/b.ts" && h.line === 2)).toBe(true);
  });

  test("formatLiteralLocate uses compact keys", () => {
    const payload = formatLiteralLocate(locateLiteral(chunks, "BAR", { mode: "lines" }));
    expect(payload).toEqual({
      literal: "BAR",
      mode: "lines",
      n: 1,
      files: 1,
      hits: [{ f: "src/a.ts", l: 11, t: "export const BAR = FOO;" }],
    });
  });
});
