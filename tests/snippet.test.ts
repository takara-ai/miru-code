import { describe, expect, test } from "bun:test";
import { formatResultsText } from "../src/mcp/format-text.ts";
import {
  anchorLineOffset,
  applySnippetsToResults,
  resolveSnippetLines,
  searchSnippetsEnabled,
  trimChunkToSnippet,
} from "../src/snippet.ts";
import type { Chunk } from "../src/types.ts";
import { formatResults } from "../src/utils.ts";

function chunk(content: string, start = 1, language: string | null = "typescript"): Chunk {
  return {
    content,
    file_path: "src/a.ts",
    start_line: start,
    end_line: start + content.split("\n").length - 1,
    language,
  };
}

const sourceLines = Array.from({ length: 40 }, () => "filler");
sourceLines.splice(18, 5, "defer func() {", "  before", "  target()", "  after", "end");

describe("search excerpts", () => {
  test.each([
    "typescript",
    "python",
    "ruby",
    "elixir",
    "go",
    "rust",
    "java",
    "html",
    "haskell",
    "ocaml",
    null,
    "unknown",
  ])("returns the same bounded source window for %s", (language) => {
    const source = chunk(sourceLines.join("\n"), 1, language);
    const { chunk: excerpt, meta } = trimChunkToSnippet(source, "target");

    expect(excerpt.content).toBe(sourceLines.slice(18, 23).join("\n"));
    expect(excerpt.start_line).toBe(19);
    expect(excerpt.end_line).toBe(23);
    expect(meta.anchor_line).toBe(21);
    expect(meta.truncated).toBe(true);
    expect(meta).not.toHaveProperty("symbol");
  });

  test.each([
    { content: "target\none\ntwo\nthree\nfour", start: 10, end: 12, anchor: 10 },
    { content: "one\ntwo\nthree\nfour\ntarget", start: 12, end: 14, anchor: 14 },
  ])("clamps excerpts at source boundaries ($anchor)", ({ content, start, end, anchor }) => {
    const source = chunk(content, 10);
    const result = trimChunkToSnippet(source, "target");
    expect(result.chunk.start_line).toBe(start);
    expect(result.chunk.end_line).toBe(end);
    expect(result.chunk.content.split("\n")).toHaveLength(3);
    expect(result.meta.anchor_line).toBe(anchor);
  });

  test("leaves complete small chunks unchanged", () => {
    const source = chunk("before\ntarget\nafter", 40);
    const result = trimChunkToSnippet(source, "target");
    expect(result.chunk).toEqual(source);
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.anchor_line).toBe(41);
  });

  test("supports an excerpt containing only the matched line", () => {
    const result = trimChunkToSnippet(chunk(sourceLines.join("\n"), 10), "target", 0);
    expect(result.chunk.content).toBe("  target()");
    expect(result.chunk.start_line).toBe(30);
    expect(result.chunk.end_line).toBe(30);
  });

  test.each([9, 99])("clamps an explicitly supplied anchor (%s)", (anchor) => {
    const source = chunk("one\ntwo\nthree\nfour\nfive", 10);
    const result = trimChunkToSnippet(source, "absent", 1, anchor);
    expect(result.meta.anchor_line).toBe(anchor < 10 ? 10 : 14);
    expect(result.chunk.content.split("\n")).toHaveLength(2);
  });

  test("keeps query anchor selection separate from excerpt formatting", () => {
    expect(anchorLineOffset("first\nquery target\nlast", "query target")).toBe(1);
  });

  test("uses source neighbours while preserving the ranked range and anchor", () => {
    const ranked = chunk("target", 20);
    const lines = [
      "target mentioned elsewhere",
      ...Array.from({ length: 17 }, () => "prefix"),
      "before",
      "target",
      "after",
      "end",
      "tail",
    ];
    const source = chunk(lines.join("\n"));
    const [output] = applySnippetsToResults(
      [{ chunk: ranked, score: 1 }],
      "target",
      undefined,
      new Map([[ranked.file_path, source]]),
    );
    expect(output?.result.chunk.content).toBe(lines.slice(17, 22).join("\n"));
    expect(output?.result.chunk.start_line).toBe(18);
    expect(output?.result.chunk.end_line).toBe(22);
    expect(output?.meta.anchor_line).toBe(20);
    expect(output?.meta.match_start_line).toBe(20);
    expect(output?.meta.match_end_line).toBe(20);
    expect(output?.meta.full_start_line).toBe(1);
    expect(output?.meta.full_end_line).toBe(lines.length);
  });

  test("renders a multi-declaration hit as a range and numbered match context", () => {
    const lines = Array.from({ length: 65 }, () => "");
    lines[0] = "func ensureClerkKey() error {";
    lines[28] = "func verifyClerkUserID() {";
    lines[35] = "  before";
    lines[37] = '  token := strings.TrimPrefix(auth, "Bearer ")';
    lines[38] = '  if token == "" {';
    lines[39] = "    return";
    const payload = formatResults("Bearer", [
      { chunk: chunk(lines.join("\n"), 1, "go"), score: 1 },
    ]);
    expect(payload.results[0]?.chunk).not.toHaveProperty("symbol");
    expect(formatResultsText(payload)).toBe(
      [
        "src/a.ts:1-65 [truncated: anchor_line 38]",
        "36:   before",
        "37: ",
        '38:   token := strings.TrimPrefix(auth, "Bearer ")',
        '39:   if token == "" {',
        "40:     return",
        "",
        "For truncated hits, read the header's line range; use expand for neighbouring chunks.",
      ].join("\n"),
    );
  });

  test("uses the same excerpt budget for every result and preserves ranking", () => {
    const first = chunk(sourceLines.join("\n"));
    const second = { ...first, file_path: "src/b.ts" };
    const output = applySnippetsToResults(
      [
        { chunk: first, score: 0.9 },
        { chunk: second, score: 0.5 },
      ],
      "target",
    );
    expect(output.map((entry) => entry.result.score)).toEqual([0.9, 0.5]);
    expect(output.map((entry) => entry.result.chunk.file_path)).toEqual(["src/a.ts", "src/b.ts"]);
    for (const entry of output) {
      expect(entry.result.chunk.content).toBe(sourceLines.slice(18, 23).join("\n"));
      expect(entry.meta).not.toHaveProperty("symbol");
    }
  });

  test("configures the number of source lines on each side, including zero", () => {
    const previous = process.env.MIRU_SNIPPET_LINES;
    try {
      delete process.env.MIRU_SNIPPET_LINES;
      expect(resolveSnippetLines()).toBe(2);
      for (const value of ["0", "1", "4"]) {
        process.env.MIRU_SNIPPET_LINES = value;
        const radius = Number(value);
        expect(resolveSnippetLines()).toBe(radius);
        const [output] = applySnippetsToResults(
          [{ chunk: chunk(sourceLines.join("\n")), score: 1 }],
          "target",
        );
        expect(output?.result.chunk.content.split("\n")).toHaveLength(radius * 2 + 1);
      }
      for (const value of ["-1", "invalid"]) {
        process.env.MIRU_SNIPPET_LINES = value;
        expect(resolveSnippetLines()).toBe(2);
      }
    } finally {
      if (previous === undefined) delete process.env.MIRU_SNIPPET_LINES;
      else process.env.MIRU_SNIPPET_LINES = previous;
    }
  });

  test("search excerpts can be explicitly enabled or disabled", () => {
    const previous = process.env.MIRU_SEARCH_SNIPPETS;
    try {
      for (const value of ["0", "false"]) {
        process.env.MIRU_SEARCH_SNIPPETS = value;
        expect(searchSnippetsEnabled()).toBe(false);
      }
      for (const value of ["1", "true", "unset value"]) {
        process.env.MIRU_SEARCH_SNIPPETS = value;
        expect(searchSnippetsEnabled()).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env.MIRU_SEARCH_SNIPPETS;
      else process.env.MIRU_SEARCH_SNIPPETS = previous;
    }
  });
});
