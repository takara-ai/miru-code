import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  commandHeader,
  divider,
  fail,
  formatRelatedHeader,
  formatSearchErrorPretty,
  formatSearchResultsPretty,
  header,
  hint,
  info,
  prefersJsonOutput,
  success,
  warn,
} from "../src/cli-ui.ts";
import { stripJsonComments as stripComments } from "../src/installer/config.ts";
import type { SearchResult } from "../src/types.ts";

describe("cli-ui", () => {
  test("renders command banners and the interactive output hint on a color TTY", () => {
    const stdout = process.stdout;
    const original = {
      isTTY: stdout.isTTY,
      columns: stdout.columns,
      write: stdout.write,
      noColor: process.env.NO_COLOR,
    };
    stdout.isTTY = true;
    stdout.columns = 100;
    stdout.write = (() => true) as typeof stdout.write;
    delete process.env.NO_COLOR;
    try {
      header();
      commandHeader("search", "Search the codebase");
      expect(
        formatSearchResultsPretty("q", [
          {
            score: 1,
            chunk: {
              content: "export const value = 1;",
              file_path: "src/value.ts",
              start_line: 1,
              end_line: 1,
              language: "typescript",
            },
          },
        ]),
      ).toContain("Tip: add --json");
    } finally {
      stdout.isTTY = original.isTTY;
      stdout.columns = original.columns;
      stdout.write = original.write;
      if (original.noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = original.noColor;
    }
  });

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

  test("formats empty, long, and multiline previews and related headers", () => {
    expect(formatSearchResultsPretty("none", [])).toContain("0 results");
    const longLine = "x".repeat(80);
    const content = [`\t${longLine}`, ...Array.from({ length: 12 }, (_, i) => `line${i}`)].join(
      "\n",
    );
    const result: SearchResult = {
      score: 0,
      chunk: { content, file_path: "a.ts", start_line: 1, end_line: 13, language: null },
    };
    const preview = formatSearchResultsPretty("q", [result, result]);
    expect(preview).toContain(`${"  ".repeat(2)}${"x".repeat(69)}…`);
    expect(preview).toContain("1 more lines");
    expect(preview).toContain("a.ts:1-13");
    expect(formatSearchErrorPretty("bad query")).toContain("bad query");
    expect(formatRelatedHeader("src/a.ts", 8)).toBe("related to src/a.ts:8");
  });

  test("writes status messages and dividers to a supplied stream", () => {
    const stream = new PassThrough();
    const writeStream = stream as unknown as NodeJS.WriteStream;
    let output = "";
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    divider("=", 3, writeStream);
    success("done", writeStream);
    info("working", writeStream);
    warn("careful", writeStream);
    fail("failed", writeStream);
    hint("tip", writeStream);
    stream.end();
    expect(output).toContain("===");
    expect(output).toContain("done");
    expect(output).toContain("working");
    expect(output).toContain("careful");
    expect(output).toContain("failed");
    expect(output).toContain("tip");
  });
});

describe("stripJsonComments", () => {
  test("removes line comments before parse", () => {
    const raw = '{\n  // comment\n  "a": 1\n}';
    expect(JSON.parse(stripComments(raw))).toEqual({ a: 1 });
  });
});
