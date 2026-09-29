import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChunkSelector } from "../src/index/chunk-selector.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { loadRootEntryChunks } from "../src/index/entry-chunks.ts";
import { detectLanguage, getFileStatus } from "../src/index/files.ts";
import { applyIncrementalFileChanges } from "../src/index/incremental.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { buildBm25FromChunks, enrichForBm25, selectorToMask } from "../src/index/sparse.ts";
import { vectorAt } from "../src/index/vectors.ts";

const chunk = (file_path: string, content = "body") => ({
  content,
  file_path,
  start_line: 1,
  end_line: 1,
  language: "ts",
});

describe("index helpers", () => {
  test("loads package entry metadata for string bin and typings fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-package-entry-"));
    try {
      expect(await loadRootEntryChunks(root)).toEqual([]);
      await writeFile(join(root, "package.json"), "{");
      expect(await loadRootEntryChunks(root)).toEqual([]);
      await writeFile(join(root, "package.json"), JSON.stringify({}));
      expect(await loadRootEntryChunks(root)).toEqual([]);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ bin: "./cli.js", typings: "./index.d.ts" }),
      );
      const [entry] = await loadRootEntryChunks(root);
      expect(entry?.file_path).toBe(join(root, "package.json").replace(/\\/g, "/"));
      expect(entry?.content).toContain("bin: ./cli.js");
      expect(entry?.content).toContain("types: ./index.d.ts");
      const [displayEntry] = await loadRootEntryChunks(root, root);
      expect(displayEntry?.file_path).toBe("package.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("covers Dockerfile, file status, and incremental skipping paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-file-status-"));
    const src = join(root, "src");
    await mkdir(src);
    try {
      expect(detectLanguage(join(root, "Dockerfile"))).toBe("dockerfile");
      const empty = join(src, "empty.ts");
      const valid = join(src, "valid.ts");
      await writeFile(empty, "  \n");
      await writeFile(valid, "export const valid = true;\n");
      expect(await getFileStatus(empty)).toBe("empty");
      expect(await getFileStatus(valid)).toBe("valid");
      const updated = await applyIncrementalFileChanges({
        root,
        content: ["code"],
        embeddings: {
          model: "test",
          dimensions: 2,
          embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
          embedQuery: async () => new Float32Array([1, 0]),
        },
        chunks: [chunk("keep.ts")],
        semanticIndex: new VectorIndex([new Float32Array([1, 0])]),
        relativePaths: ["src/empty.ts", "src/missing.ts"],
      });
      expect(updated.chunks.map((item) => item.file_path)).toEqual(["keep.ts"]);
      expect(
        buildChunkSelector(
          { fileMapping: new Map([["src/file.ts", [0]]]), languageMapping: new Map() },
          ["missing"],
          ["unknown.ts"],
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("builds selector masks and handles invalid indices", () => {
    expect(selectorToMask(null, 3)).toBeUndefined();
    expect(selectorToMask([], 3)).toBeUndefined();
    expect(selectorToMask([0, 2, -1, 3], 3)).toEqual([true, false, true]);
  });

  test("enriches BM25 text from path and builds documents", () => {
    expect(buildBm25FromChunks([]).getScores(["anything"])).toEqual([]);
    expect(enrichForBm25(chunk("../src\\index\\search.ts"))).toBe("body search search src index");
    const index = buildBm25FromChunks([chunk("src/search.ts", "authentication middleware")]);
    expect(index.getScores(["authentication"])).toHaveLength(1);
    expect(index.getScores(["authentication"])[0]).toBeGreaterThan(0);
  });

  test("recovers float vectors from both index formats", () => {
    const float = new VectorIndex([new Float32Array([1, 0])]);
    const quantized = new QuantizedVectorIndex([new Float32Array([1, 0])]);
    expect(Array.from(vectorAt(float, 0))).toEqual([1, 0]);
    expect(Array.from(vectorAt(quantized, 0)[0] === 1 ? vectorAt(quantized, 0) : [])).toEqual([
      1, 0,
    ]);
    expect(() => vectorAt(float, 2)).toThrow("Missing vector");
    expect(() => vectorAt({} as VectorIndex, 0)).toThrow("Unsupported semantic index type");
  });
});
