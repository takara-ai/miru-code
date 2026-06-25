import { describe, expect, test } from "bun:test";
import {
  formatBrandBannerLines,
  formatBrandCompactLine,
  formatSearchResultsPretty,
  isQuietBrand,
  prefersJsonOutput,
} from "../src/cli-ui.ts";
import { stripJsonComments as stripComments } from "../src/installer/config.ts";
import type { SearchResult } from "../src/types.ts";

describe("cli-ui", () => {
  test("formatSearchResultsPretty includes location and score", () => {
    const results: SearchResult[] = [
      {
        score: 0.812,
        chunk: {
          content: "export function auth() {\n  return true;\n}",
          file_path: "src/auth.ts",
          start_line: 1,
          end_line: 3,
          language: "typescript",
        },
      },
    ];
    const text = formatSearchResultsPretty("auth middleware", results);
    expect(text).toContain("auth middleware");
    expect(text).toContain("src/auth.ts:1-3");
    expect(text).toContain("100%");
    expect(text).toContain("export function auth()");
  });

  test("prefersJsonOutput when --json or non-tty", () => {
    expect(prefersJsonOutput(true)).toBe(true);
    expect(prefersJsonOutput(false)).toBe(!process.stdout.isTTY);
  });

  test("formatBrandBannerLines renders boxed wordmark", () => {
    const text = formatBrandBannerLines("hybrid code search").join("\n");
    expect(text).toContain("╭");
    expect(text).toContain("MIRU");
    expect(text).toContain("見る");
    expect(text).toContain("hybrid code search");
  });

  test("formatBrandCompactLine includes optional tagline", () => {
    expect(formatBrandCompactLine()).toContain("MIRU");
    expect(formatBrandCompactLine("search")).toContain("search");
  });

  test("isQuietBrand reads MIRU_QUIET", () => {
    const previous = process.env.MIRU_QUIET;
    process.env.MIRU_QUIET = "1";
    expect(isQuietBrand()).toBe(true);
    if (previous === undefined) {
      delete process.env.MIRU_QUIET;
    } else {
      process.env.MIRU_QUIET = previous;
    }
  });
});

describe("stripJsonComments", () => {
  test("removes line comments before parse", () => {
    const raw = '{\n  // comment\n  "a": 1\n}';
    expect(JSON.parse(stripComments(raw))).toEqual({ a: 1 });
  });
});
