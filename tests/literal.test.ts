import { describe, expect, test } from "bun:test";
import {
  formatLiteralLocate,
  hasRegexLiteral,
  listIndexedFiles,
  locateLiteral,
  stitchSplitLines,
} from "../src/literal.ts";
import { formatLiteralLocateText } from "../src/mcp/format-text.ts";
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
  test("returns no hits for empty literal input", () => {
    expect(locateLiteral(chunks, "", { mode: "lines", match_variants: true })).toMatchObject({
      literal: "",
      mode: "lines",
      n: 0,
      files: 0,
      truncated: false,
      hits: [],
    });
    expect(locateLiteral(chunks, ["", ""], { mode: "lines" }).n).toBe(0);
  });

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

  test("match_variants ignores punctuation with no identifier words", () => {
    const result = locateLiteral(chunks, "   ", { mode: "count", match_variants: true });
    expect(result.n).toBe(0);
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

describe("regex literals, files mode, and file listing", () => {
  const chunk = (file_path: string, content: string, start_line = 1): Chunk => ({
    content,
    file_path,
    start_line,
    end_line: start_line + content.split("\n").length - 1,
    language: "typescript",
  });
  const chunks = [
    chunk("src/a.ts", "export const MCP_ONE = 1;\nconst x = 2;\nexport const MCP_TWO = 3;"),
    chunk("src/b.test.ts", "// TODO fix\nexport async function run() {}"),
    chunk("docs/api.md", "see /api/users/ for details"),
  ];

  test("a slash-wrapped literal with regex syntax matches per line", () => {
    const result = locateLiteral(chunks, "/export const MCP_[A-Z]+ =/", { mode: "locations" });
    expect(result.n).toBe(2);
    expect(result.hits.map((h) => `${h.file_path}:${h.line}`)).toEqual([
      "src/a.ts:1",
      "src/a.ts:3",
    ]);
  });

  test("regex supports alternation, anchors, /i, and ignore_case", () => {
    expect(locateLiteral(chunks, "/todo|FIXME/i", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(chunks, "/todo|FIXME/", { mode: "count" }).n).toBe(0);
    expect(locateLiteral(chunks, "/^const x/", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(chunks, "/to.o/", { mode: "count", ignore_case: true }).n).toBe(1);
  });

  test("a slash-wrapped word is a regex, so /i works without regex syntax", () => {
    expect(locateLiteral(chunks, "/TODO/i", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(chunks, "/todo/i", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(chunks, "/todo/", { mode: "count" }).n).toBe(0);
  });

  test("a path is a plain substring once the outer slashes are dropped", () => {
    const result = locateLiteral(chunks, "api/users/", { mode: "count" });
    expect(result.n).toBe(1);
  });

  test("line anchors stay line-relative when a chunk is prefiltered as a whole", () => {
    const multi = [chunk("src/m.ts", "alpha\nbeta;\n  gamma\n")];
    expect(locateLiteral(multi, "/^beta/", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(multi, "/a;$/", { mode: "count" }).n).toBe(1);
    expect(locateLiteral(multi, "/^gamma/", { mode: "count" }).n).toBe(0);
    expect(locateLiteral(multi, "/alpha\\nbeta/", { mode: "count" }).n).toBe(0);
  });

  test("regex and plain literals can be mixed in one OR call", () => {
    const result = locateLiteral(chunks, ["/MCP_[A-Z]+ =/", "TODO"], { mode: "count" });
    expect(result.n).toBe(3);
  });

  test("an invalid regex reports a clear error", () => {
    expect(() => locateLiteral(chunks, "/foo(/", {})).toThrow(/Invalid regex \/foo\(\//);
  });

  test("hasRegexLiteral distinguishes regex from plain literals", () => {
    expect(hasRegexLiteral("/a.*b/")).toBe(true);
    expect(hasRegexLiteral("/benchmark/i")).toBe(true);
    expect(hasRegexLiteral("api/users/")).toBe(false);
    expect(hasRegexLiteral(["plain", "/x+/"])).toBe(true);
  });

  test("files mode returns sorted unique paths and no hits", () => {
    const result = locateLiteral(chunks, "/MCP_[A-Z]+/", { mode: "files" });
    expect(result.file_list).toEqual(["src/a.ts"]);
    expect(result.hits).toEqual([]);
    expect(result.files).toBe(1);
    expect(formatLiteralLocate(result).paths).toEqual(["src/a.ts"]);
  });

  test("listIndexedFiles scopes by include/exclude and supports count", () => {
    const listed = listIndexedFiles(chunks, { include: ["**/*.test.ts"] });
    expect(listed.file_list).toEqual(["src/b.test.ts"]);
    expect(
      listIndexedFiles(chunks, { include: ["src/**"], exclude: ["*.test.ts"] }).file_list,
    ).toEqual(["src/a.ts"]);
    const counted = listIndexedFiles(chunks, { include: ["src/**"], mode: "count" });
    expect(counted.n).toBe(2);
    expect(counted.file_list).toBeUndefined();
  });
});

describe("split-line stitching", () => {
  const frag = (content: string, start_line: number, end_line: number): Chunk => ({
    content,
    file_path: "src/x.ts",
    start_line,
    end_line,
    language: "typescript",
  });

  test("rejoins a line the chunker split across two chunks", () => {
    const split = [frag("a\nexpo", 1, 2), frag("rt async function f() {}\nb", 2, 3)];
    expect(stitchSplitLines(split)).toHaveLength(1);
    expect(locateLiteral(split, "export async function f", { mode: "locations" }).hits).toEqual([
      { file_path: "src/x.ts", line: 2 },
    ]);
    expect(locateLiteral(split, "/^export (async )?function /", { mode: "count" }).n).toBe(1);
  });

  test("leaves chunks that do not share a line alone", () => {
    const apart = [frag("a", 1, 1), frag("b", 2, 2), frag("c", 5, 6)];
    expect(stitchSplitLines(apart)).toHaveLength(3);
  });
});

describe("locate text format", () => {
  const chunk = (file_path: string, content: string): Chunk => ({
    content,
    file_path,
    start_line: 1,
    end_line: content.split("\n").length,
    language: "typescript",
  });
  const chunks = [
    chunk("a.ts", "hit one\nmiss\nhit two"),
    chunk("src/b.ts", "only hit here"),
    chunk("src/c.ts", "hit ".padEnd(600, "x")),
  ];
  const text = (mode: "lines" | "locations") =>
    formatLiteralLocateText(formatLiteralLocate(locateLiteral(chunks, "hit", { mode })));

  test("lines mode prints each path once, inlines single hits, and clips long lines", () => {
    const out = text("lines");
    expect(out).toContain("a.ts\n  1: hit one\n  3: hit two");
    expect(out).toContain("src/b.ts:1: only hit here");
    expect(out).toMatch(/src\/c\.ts:1: hit x+… \[\+\d+ chars\]/);
  });

  test("locations mode lists line numbers per file", () => {
    expect(text("locations")).toContain("a.ts: 1, 3");
    expect(text("locations")).toContain("src/b.ts: 1");
  });

  test("a regex header omits the echoed pattern, a plain literal keeps it", () => {
    const regexOut = formatLiteralLocateText(
      formatLiteralLocate(locateLiteral(chunks, "/hit.+/", { mode: "count" })),
    );
    expect(regexOut).toBe("4 matches across 3 files");
    expect(text("locations")).toContain('"hit": 4 matches across 3 files');
  });
});
