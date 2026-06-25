import { describe, expect, test } from "bun:test";
import { buildChunkSelector, type ChunkIndexMappings } from "../src/index/chunk-selector.ts";

/** Reference impl: always union + dedup, never borrows map arrays. */
function buildChunkSelectorUnion(
  mappings: ChunkIndexMappings,
  filterLanguages?: readonly string[],
  filterPaths?: readonly string[],
): readonly number[] | undefined {
  const selector: number[] = [];
  for (const lang of filterLanguages ?? []) {
    selector.push(...(mappings.languageMapping.get(lang) ?? []));
  }
  for (const fp of filterPaths ?? []) {
    selector.push(...(mappings.fileMapping.get(fp) ?? []));
  }
  if (selector.length === 0) {
    return undefined;
  }
  return [...new Set(selector)].sort((a, b) => a - b);
}

function sorted(selector: readonly number[] | undefined): readonly number[] | undefined {
  return selector ? [...selector].sort((a, b) => a - b) : undefined;
}

function makeMappings(): ChunkIndexMappings & {
  fileMapping: Map<string, number[]>;
  languageMapping: Map<string, number[]>;
} {
  const fileMapping = new Map<string, number[]>([
    ["src/a.ts", [0, 1]],
    ["src/b.ts", [2]],
    ["src/c.py", [3, 4]],
  ]);
  const languageMapping = new Map<string, number[]>([
    ["typescript", [0, 1, 2]],
    ["python", [3, 4]],
  ]);
  return { fileMapping, languageMapping };
}

describe("buildChunkSelector", () => {
  test("returns undefined when no filters are given", () => {
    const mappings = makeMappings();
    expect(buildChunkSelector(mappings)).toBeUndefined();
    expect(buildChunkSelector(mappings, [], [])).toBeUndefined();
  });

  test("returns undefined when filters match nothing", () => {
    const mappings = makeMappings();
    expect(buildChunkSelector(mappings, ["rust"])).toBeUndefined();
    expect(buildChunkSelector(mappings, undefined, ["missing.ts"])).toBeUndefined();
  });

  test("single language fast path matches union semantics", () => {
    const mappings = makeMappings();
    const optimized = buildChunkSelector(mappings, ["typescript"]);
    const reference = buildChunkSelectorUnion(mappings, ["typescript"]);

    expect(sorted(optimized)).toEqual(reference);
    expect(optimized).toBe(mappings.languageMapping.get("typescript"));
  });

  test("single path fast path matches union semantics", () => {
    const mappings = makeMappings();
    const optimized = buildChunkSelector(mappings, undefined, ["src/b.ts"]);
    const reference = buildChunkSelectorUnion(mappings, undefined, ["src/b.ts"]);

    expect(sorted(optimized)).toEqual(reference);
    expect(optimized).toBe(mappings.fileMapping.get("src/b.ts"));
  });

  test("multiple languages use union semantics", () => {
    const mappings = makeMappings();
    const optimized = sorted(buildChunkSelector(mappings, ["typescript", "python"]));
    const reference = buildChunkSelectorUnion(mappings, ["typescript", "python"]);

    expect(optimized).toEqual(reference);
    expect(optimized).toEqual([0, 1, 2, 3, 4]);
  });

  test("language and path filters union and dedupe overlaps", () => {
    const mappings = makeMappings();
    const optimized = sorted(buildChunkSelector(mappings, ["typescript"], ["src/c.py"]));
    const reference = buildChunkSelectorUnion(mappings, ["typescript"], ["src/c.py"]);

    expect(optimized).toEqual(reference);
    expect(optimized).toEqual([0, 1, 2, 3, 4]);
  });

  test("A/B agrees on synthetic large mappings", () => {
    const fileMapping = new Map<string, number[]>();
    const languageMapping = new Map<string, number[]>([
      ["typescript", []],
      ["python", []],
      ["go", []],
    ]);

    for (let i = 0; i < 5_000; i++) {
      const fp = `src/dir${i % 50}/file${i}.ts`;
      let fileIndices = fileMapping.get(fp);
      if (!fileIndices) {
        fileIndices = [];
        fileMapping.set(fp, fileIndices);
      }
      fileIndices.push(i);
      const langs = ["typescript", "python", "go"] as const;
      const lang = langs[i % langs.length];
      const langIndices = languageMapping.get(lang);
      langIndices?.push(i);
    }

    const mappings = { fileMapping, languageMapping };
    const cases: Array<[readonly string[] | undefined, readonly string[] | undefined]> = [
      [undefined, undefined],
      [["typescript"], undefined],
      [["typescript", "python"], undefined],
      [undefined, ["src/dir1/file100.ts"]],
      [["go"], ["src/dir2/file200.ts"]],
      [
        ["typescript", "go"],
        ["src/dir3/file300.ts", "src/dir4/file400.ts"],
      ],
    ];

    for (const [langs, paths] of cases) {
      const optimized = sorted(buildChunkSelector(mappings, langs, paths));
      const reference = buildChunkSelectorUnion(mappings, langs, paths);
      expect(optimized).toEqual(reference);
    }
  });
});
