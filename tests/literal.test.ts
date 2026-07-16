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

  test("literals array OR-matches multiple substrings in one call", () => {
    const result = locateLiteral(chunks, ["BAR", "Z"], { mode: "locations" });
    expect(result.literal).toBe("BAR | Z");
    expect(result.literals).toEqual(["BAR", "Z"]);
    expect(result.n).toBe(2);
    expect(result.hits).toEqual([
      { file_path: "src/a.ts", line: 11 },
      { file_path: "src/a.ts", line: 13 },
    ]);
  });

  test("literals array dedupes overlapping hits across variants", () => {
    // "FOO" and "BAR" both hit src/a.ts:11 — must not double count.
    const result = locateLiteral(chunks, ["FOO", "BAR"], { mode: "count" });
    expect(result.n).toBe(3);
  });

  test("single literal omits the `literals` field for backward compatibility", () => {
    const result = locateLiteral(chunks, "FOO", { mode: "count" });
    expect(result.literals).toBeUndefined();
  });

  test("match_variants expands camelCase into other casings", () => {
    const variantChunks = [
      {
        file_path: "src/rate.ts",
        start_line: 1,
        end_line: 3,
        language: "typescript",
        content: "const rateLimit = 1;\nconst unrelated = 2;\nconst rate_limit_window = 3;",
      },
    ];
    const result = locateLiteral(variantChunks, "rateLimit", {
      mode: "lines",
      match_variants: true,
    });
    expect(result.n).toBe(2);
    expect(result.literals).toEqual(
      expect.arrayContaining(["rateLimit", "RateLimit", "rate_limit", "rate-limit", "RATE_LIMIT"]),
    );
    expect(result.hits.map((h) => h.line)).toEqual([1, 3]);
  });

  test("match_variants on snake_case input finds camelCase usage", () => {
    const variantChunks = [
      {
        file_path: "src/rate.ts",
        start_line: 1,
        end_line: 1,
        language: "typescript",
        content: "function rateLimit() {}",
      },
    ];
    const result = locateLiteral(variantChunks, "rate_limit", {
      mode: "count",
      match_variants: true,
    });
    expect(result.n).toBe(1);
  });

  test("include restricts matches to files under the glob", () => {
    const result = locateLiteral(chunks, "FOO", {
      mode: "locations",
      include: ["src/a.ts"],
    });
    expect(result.n).toBe(2);
    expect(result.hits.every((h) => h.file_path === "src/a.ts")).toBe(true);
  });

  test("include supports ** glob scoping", () => {
    const nested = [
      ...chunks,
      {
        file_path: "apps/tldr/handler.ts",
        start_line: 1,
        end_line: 1,
        language: "typescript",
        content: "const FOO = 99;",
      },
    ];
    const result = locateLiteral(nested, "FOO", {
      mode: "locations",
      include: ["apps/tldr/**/*.ts"],
    });
    expect(result.n).toBe(1);
    expect(result.hits).toEqual([{ file_path: "apps/tldr/handler.ts", line: 1 }]);
  });

  test("exclude drops matches from files under the glob", () => {
    const result = locateLiteral(chunks, "FOO", {
      mode: "locations",
      exclude: ["src/a.ts"],
    });
    expect(result.n).toBe(1);
    expect(result.hits).toEqual([{ file_path: "src/b.ts", line: 1 }]);
  });

  test("context_lines returns surrounding lines in lines mode", () => {
    const result = locateLiteral(chunks, "BAR", { mode: "lines", context_lines: 1 });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit?.context).toEqual(["const FOO = 1;", "export const BAR = FOO;", "// end"]);
    expect(hit?.context_start_line).toBe(10);
  });

  test("context_lines clamps at chunk boundaries", () => {
    const result = locateLiteral(chunks, "FOO", {
      mode: "lines",
      context_lines: 5,
    });
    const first = result.hits.find((h) => h.file_path === "src/a.ts" && h.line === 10);
    // Chunk only has 3 lines (10-12); context can't extend past it.
    expect(first?.context).toEqual(["const FOO = 1;", "export const BAR = FOO;", "// end"]);
    expect(first?.context_start_line).toBe(10);
  });

  test("formatLiteralLocate includes compact ctx keys when context_lines set", () => {
    const payload = formatLiteralLocate(
      locateLiteral(chunks, "BAR", { mode: "lines", context_lines: 1 }),
    );
    const hits = payload.hits as Array<{ ctx?: string[]; ctx_l?: number }>;
    expect(hits[0]?.ctx).toEqual(["const FOO = 1;", "export const BAR = FOO;", "// end"]);
    expect(hits[0]?.ctx_l).toBe(10);
  });
});
