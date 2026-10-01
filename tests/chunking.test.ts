import { describe, expect, test } from "bun:test";
import { chunkAst } from "../src/chunking/ast.ts";
import { chunkSource } from "../src/chunking/chunking.ts";
import { chunkLines, mergeAdjacentChunks, splitLinesKeepEnds } from "../src/chunking/lines.ts";
import { chunkStructural, structuralTestUtils } from "../src/chunking/structural.ts";
import { CHUNK_PARITY_FIXTURES } from "./chunk-parity-fixtures.ts";

describe("chunkStructural", () => {
  test("returns empty or unsupported results when structural declarations are absent", () => {
    expect(chunkStructural("", "python", 20)).toEqual([]);
    expect(chunkStructural("plain text without declarations", "typescript", 20)).toBeNull();
    expect(chunkStructural("def f():\n    return 1", null, 20)).toBeNull();
  });

  for (const fixture of CHUNK_PARITY_FIXTURES) {
    test(`${fixture.language} parity fixture yields multiple structural chunks`, () => {
      const boundaries =
        chunkStructural(fixture.source, fixture.language, fixture.desiredLength) ?? [];
      expect(boundaries.length).toBeGreaterThanOrEqual(2);

      const slices = boundaries.map(({ start, end }) => fixture.source.slice(start, end));
      expect(new Set(slices.map((s) => s.trim())).size).toBe(slices.length);
    });
  }
});

describe("chunkSource", () => {
  test("returns no chunks for an empty source", async () => {
    expect(await chunkSource(" \n ", "empty.ts", "typescript")).toEqual([]);
    expect(await chunkAst(" \n ", "empty.ts", "typescript", 100)).toBeNull();
    expect(await chunkAst("const value = 1;", "unknown.file", null, 100)).toBeNull();
  });

  test("falls back when parser errors or returns no tree", async () => {
    const deps = {
      getLanguage: async () => ({}) as never,
      createParser: () =>
        ({
          setLanguage: () => {},
          parse: () => {
            throw new Error("parse failed");
          },
        }) as never,
    };
    expect(await chunkAst("const value = 1;", "test.ts", "typescript", 100, deps)).toBeNull();
    expect(
      await chunkAst("const value = 1;", "test.ts", "typescript", 100, {
        ...deps,
        createParser: () => ({ setLanguage: () => {}, parse: () => null }) as never,
      }),
    ).toBeNull();
  });

  test("deletes the parser and tree on every path so wasm memory is released", async () => {
    const deleted: string[] = [];
    const parserWith = (parse: () => unknown) => () =>
      ({
        setLanguage: () => {},
        parse,
        delete: () => deleted.push("parser"),
      }) as never;
    const tree = {
      rootNode: { childCount: 0, startIndex: 0, endIndex: 5, children: [] },
      delete: () => deleted.push("tree"),
    };
    const run = (createParser: () => never) =>
      chunkAst("hello", "test.ts", "typescript", 100, {
        getLanguage: async () => ({}) as never,
        createParser,
      });

    await run(parserWith(() => tree));
    expect(deleted).toEqual(["tree", "parser"]);

    deleted.length = 0;
    await run(parserWith(() => null));
    await run(
      parserWith(() => {
        throw new Error("parse failed");
      }),
    );
    expect(deleted).toEqual(["parser", "parser"]);
  });

  test("uses leaf boundaries and stops descending beyond the recursion limit", async () => {
    const leaf = { childCount: 0, startIndex: 0, endIndex: 60, children: [] };
    const leafResult = await chunkAst("x".repeat(60), "test.ts", "typescript", 10, {
      getLanguage: async () => ({}) as never,
      createParser: () =>
        ({
          setLanguage: () => {},
          parse: () => ({
            rootNode: { childCount: 1, startIndex: 0, endIndex: 60, children: [leaf] },
            delete: () => {},
          }),
        }) as never,
    });
    expect(leafResult).toEqual([{ start: 0, end: 60 }]);

    let node: { childCount: number; startIndex: number; endIndex: number; children: unknown[] } = {
      childCount: 1,
      startIndex: 0,
      endIndex: 600,
      children: [],
    };
    for (let depth = 0; depth < 502; depth++) {
      node = { childCount: 1, startIndex: 0, endIndex: 600, children: [node] };
    }
    const deepResult = await chunkAst("x".repeat(600), "test.ts", "typescript", 10, {
      getLanguage: async () => ({}) as never,
      createParser: () =>
        ({
          setLanguage: () => {},
          parse: () => ({ rootNode: node, delete: () => {} }),
        }) as never,
    });
    expect(deepResult).toEqual([{ start: 0, end: 600 }]);
  });

  test("preserves valid line numbers and non-empty content", async () => {
    const fixture = CHUNK_PARITY_FIXTURES[0];
    if (!fixture) {
      throw new Error("Missing python parity fixture");
    }
    const chunks = await chunkSource(fixture.source, "service.py", fixture.language);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.start_line).toBeGreaterThan(0);
      expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
      expect(chunk.content.trim().length).toBeGreaterThan(0);
      expect(chunk.file_path).toBe("service.py");
      expect(fixture.source).toContain(chunk.content.trim().slice(0, 40));
    }
  });

  test("splits very large sources into multiple chunks", async () => {
    const fixture = CHUNK_PARITY_FIXTURES[0];
    if (!fixture) {
      throw new Error("Missing python parity fixture");
    }
    const largeSource = Array.from({ length: 4 }, () => fixture.source).join("\n\n");
    const chunks = await chunkSource(largeSource, "large.py", fixture.language);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("line chunking helpers", () => {
  test("splits empty and mixed newline input while preserving endings", () => {
    expect(splitLinesKeepEnds("")).toEqual([]);
    expect(splitLinesKeepEnds("one\r\ntwo\rthree\n").map((line) => line.text)).toEqual([
      "one\r\n",
      "two\r",
      "three\n",
    ]);
    expect(chunkLines(" \n", 10)).toEqual([]);
  });

  test("merges chunks and handles sparse input safely", () => {
    expect(mergeAdjacentChunks([], 5)).toEqual([]);
    expect(chunkLines("one\ntwo", 10)).toEqual([{ start: 0, end: 7 }]);
    expect(
      mergeAdjacentChunks(
        [
          { start: 0, end: 2 },
          { start: 2, end: 4 },
        ],
        5,
      ),
    ).toEqual([{ start: 0, end: 4 }]);
    expect(mergeAdjacentChunks(new Array(1), 5)).toEqual([]);
  });
});

describe("Python class structural edge cases", () => {
  test("keeps classes without methods and all methods of a class with decorators", () => {
    const source = [
      "class Empty:",
      "    value = 1",
      "",
      "class Service:",
      "    @property",
      "    def first(self):",
      "        return 1",
      "",
      "    def second(self):",
      "        return 2",
      "",
      "def outside():",
      "    return 3",
      "",
    ].join("\n");
    const boundaries = chunkStructural(source, "python", 5) ?? [];
    expect(boundaries.map(({ start, end }) => source.slice(start, end).trim())).toContain(
      "class Empty:\n    value = 1",
    );
    expect(boundaries.map(({ start, end }) => source.slice(start, end)).join("\n")).toContain(
      "def second(self):",
    );
  });
});

describe("brace structural edge cases", () => {
  test("identifies nested declarations without skipping type declarations", () => {
    expect(structuralTestUtils.shouldSkipNestedBraceDecl("  int nested() {}", "cpp")).toBe(true);
    expect(structuralTestUtils.shouldSkipNestedBraceDecl("  struct Nested {}", "cpp")).toBe(false);
    expect(structuralTestUtils.shouldSkipNestedBraceDecl("  int nested() {}", "c")).toBe(true);
    expect(structuralTestUtils.shouldSkipNestedBraceDecl("int outer() {}", "c")).toBe(false);
    expect(structuralTestUtils.shouldSkipNestedBraceDecl("  int nested() {}", "go")).toBe(false);
  });

  test("ignores indented C++ function declarations that are not type declarations", () => {
    const source = "int outer() {\n  int nested() { return 1; }\n  return nested();\n}\n";
    const boundaries = chunkStructural(source, "cpp", 5) ?? [];
    expect(boundaries.map(({ start, end }) => source.slice(start, end)).join("\n")).toContain(
      "int outer()",
    );
  });

  test("recognizes C type declarations and ignores an indented nested function", () => {
    const source =
      "struct Item { int value; };\nint outer(void) {\n  int nested(void) { return 1; }\n  return 0;\n}\n";
    const boundaries = chunkStructural(source, "c", 5) ?? [];
    const text = boundaries.map(({ start, end }) => source.slice(start, end)).join("\n");
    expect(text).toContain("struct Item");
    expect(text).toContain("int outer");
    expect(chunkStructural("  int nested(void) { return 1; }\n", "c", 5)).toBeNull();
  });
});
