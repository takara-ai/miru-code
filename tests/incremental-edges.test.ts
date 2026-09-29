import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { VectorIndex } from "../src/index/dense.ts";
import {
  applyIncrementalFileChanges,
  normalizeRelativePath,
  relativePathFromRoot,
} from "../src/index/incremental.ts";
import type { Chunk } from "../src/types.ts";

const embedding: EmbeddingBackend = {
  model: "test",
  dimensions: 2,
  embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
  embedQuery: async () => new Float32Array([1, 0]),
};
const old: Chunk = {
  content: "old content",
  file_path: "old.ts",
  start_line: 1,
  end_line: 1,
  language: "typescript",
};

describe("incremental indexing edge cases", () => {
  test("normalizes separators and maps paths outside the root without escaping it", () => {
    expect(normalizeRelativePath(".\\src\\file.ts")).toBe("src/file.ts");
    const root = join(tmpdir(), "miru-relative-root");
    expect(relativePathFromRoot(root, join(tmpdir(), "outside.ts"))).toBe(
      join(tmpdir(), "outside.ts"),
    );
    expect(relativePathFromRoot(root, "src/file.ts")).toBe("src/file.ts");
  });

  test("keeps indexes unchanged when no supported paths are requested", async () => {
    const semantic = new VectorIndex([new Float32Array([1, 0])]);
    const result = await applyIncrementalFileChanges({
      root: tmpdir(),
      content: ["code"],
      embeddings: embedding,
      chunks: [old],
      semanticIndex: semantic,
      relativePaths: ["", "README.md", "note.md"],
    });
    expect(result.chunks).toEqual([old]);
    expect(result.semantic).toBe(semantic);
    expect(result.bm25).toBeDefined();
  });

  test("drops deleted files, skips missing inputs, and tolerates sparse chunk slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-incremental-"));
    try {
      const kept = { ...old, file_path: "keep.ts" };
      const changed = { ...old, file_path: "gone.ts" };
      const chunks = [kept, undefined, changed] as (Chunk | undefined)[] as Chunk[];
      const semantic = new VectorIndex([
        new Float32Array([1, 0]),
        new Float32Array([0, 1]),
        new Float32Array([1, 1]),
      ]);
      const result = await applyIncrementalFileChanges({
        root,
        content: ["code"],
        embeddings: embedding,
        chunks,
        semanticIndex: semantic,
        relativePaths: ["gone.ts", "not-found.ts", "Dockerfile", "README.md"],
      });
      expect(result.chunks.map((chunk) => chunk.file_path)).toEqual(["keep.ts"]);
      expect(result.semantic.size).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a changed source and rejects updates with mismatched embeddings", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-incremental-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.ts"), "export const freshValue = 1;\n");
      const result = await applyIncrementalFileChanges({
        root,
        content: ["code"],
        embeddings: embedding,
        chunks: [old],
        semanticIndex: new VectorIndex([new Float32Array([1, 0])]),
        relativePaths: ["src/a.ts"],
      });
      expect(result.chunks.some((chunk) => chunk.content.includes("freshValue"))).toBe(true);
      const badEmbeddings = { ...embedding, embedDocuments: async () => [] };
      await expect(
        applyIncrementalFileChanges({
          root,
          content: ["code"],
          embeddings: badEmbeddings,
          chunks: [],
          semanticIndex: new VectorIndex([]),
          relativePaths: ["src/a.ts"],
        }),
      ).rejects.toThrow("Vector count");
      await expect(
        applyIncrementalFileChanges({
          root,
          content: ["code"],
          embeddings: embedding,
          chunks: [old],
          semanticIndex: new VectorIndex([new Float32Array([1, 0])]),
          relativePaths: ["old.ts"],
        }),
      ).rejects.toThrow("No indexed chunks remain");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
