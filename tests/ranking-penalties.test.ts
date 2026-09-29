import { describe, expect, test } from "bun:test";
import { rerankTopk } from "../src/ranking/penalties.ts";
import type { Chunk } from "../src/types.ts";

function chunk(file_path: string): Chunk {
  return { file_path, content: "content", start_line: 1, end_line: 2, language: "text" };
}

describe("path ranking penalties", () => {
  test("applies test, re-export, compatibility, example, and type definition penalties", () => {
    const paths = [
      "src/module.ts",
      "src/module.test.ts",
      "src/__init__.py",
      "src/compat/module.ts",
      "docs/examples/module.ts",
      "types/index.d.ts",
      "src\\windows_test.go",
    ];
    const chunks = paths.map(chunk);
    const byKey = new Map(chunks.map((entry, i) => [String(i), entry]));
    const scores = new Map(paths.map((_path, i) => [String(i), 1]));
    const ranked = rerankTopk(scores, byKey, paths.length);
    expect(ranked.map(([entry]) => entry.file_path)[0]).toBe("src/module.ts");
    expect(ranked.find(([entry]) => entry.file_path === "src/module.test.ts")?.[1]).toBe(0.3);
    expect(ranked.find(([entry]) => entry.file_path === "src/__init__.py")?.[1]).toBe(0.5);
    expect(ranked.find(([entry]) => entry.file_path === "src/compat/module.ts")?.[1]).toBe(0.3);
    expect(ranked.find(([entry]) => entry.file_path === "docs/examples/module.ts")?.[1]).toBe(0.3);
    expect(ranked.find(([entry]) => entry.file_path === "types/index.d.ts")?.[1]).toBe(0.7);
    expect(ranked.find(([entry]) => entry.file_path === "src\\windows_test.go")?.[1]).toBe(0.3);
  });

  test("handles empty, missing, disabled, and saturated selections", () => {
    expect(rerankTopk(new Map(), new Map(), 3)).toEqual([]);
    const one = chunk("src/a.ts");
    const byKey = new Map([["a", one]]);
    const scores = new Map([
      ["missing", 5],
      ["a", 4],
      ["b", 3],
    ]);
    const noPenalty = rerankTopk(
      scores,
      new Map([
        ["a", one],
        ["b", one],
      ]),
      1,
      false,
    );
    expect(noPenalty).toHaveLength(1);
    expect(noPenalty[0]?.[1]).toBe(4);
    const saturated = rerankTopk(
      new Map([
        ["a", 4],
        ["b", 3],
      ]),
      new Map([
        ["a", one],
        ["b", one],
      ]),
      2,
    );
    expect(saturated[0]?.[1]).toBe(4);
    expect(saturated[1]?.[1]).toBe(1.5);
    const other = chunk("src/b.ts");
    expect(
      rerankTopk(
        new Map([
          ["a", 4],
          ["b", 3],
        ]),
        new Map([
          ["a", one],
          ["b", other],
        ]),
        1,
      ),
    ).toHaveLength(1);
    expect(rerankTopk(new Map([["a", 1]]), byKey, 0)).toEqual([]);

    const third = chunk("src/c.ts");
    const stopped = rerankTopk(
      new Map([
        ["a", 4],
        ["b", 2],
        ["c", 1],
      ]),
      new Map([
        ["a", one],
        ["b", other],
        ["c", third],
      ]),
      1,
    );
    expect(stopped).toHaveLength(1);
  });
});
