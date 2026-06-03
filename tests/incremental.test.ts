import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import {
  applyIncrementalFileChanges,
  normalizeRelativePath,
  relativePathFromRoot,
} from "../src/index/incremental.ts";
import type { Chunk } from "../src/types.ts";
import { unitVector } from "./test-helpers.ts";

function mockEmbeddings(vectorsByText: Record<string, Float32Array>): EmbeddingBackend {
  const dim = Object.values(vectorsByText)[0]?.length ?? 4;
  return {
    model: "mock",
    dimensions: dim,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => vectorsByText[text] ?? unitVector(dim, 0));
    },
    async embedQuery() {
      return unitVector(dim, 0);
    },
  };
}

describe("incremental index", () => {
  test("normalizeRelativePath and relativePathFromRoot", () => {
    expect(normalizeRelativePath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(relativePathFromRoot("/proj", "src/a.ts")).toBe("src/a.ts");
    expect(relativePathFromRoot("/proj", "/proj/src/a.ts")).toBe("src/a.ts");
  });

  test("applyIncrementalFileChanges re-embeds only changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-inc-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "export const alpha = 1;\n", "utf-8");
      await writeFile(join(root, "src/b.ts"), "export const beta = 2;\n", "utf-8");

      const chunks: Chunk[] = [
        {
          content: "export const alpha = 1;",
          file_path: "src/a.ts",
          start_line: 1,
          end_line: 1,
          language: "typescript",
        },
        {
          content: "export const beta = 2;",
          file_path: "src/b.ts",
          start_line: 1,
          end_line: 1,
          language: "typescript",
        },
      ];
      const vecA = unitVector(8, 0);
      const vecB = unitVector(8, 1);
      const semantic = new VectorIndex([vecA, vecB]);

      await writeFile(join(root, "src/a.ts"), "export const alpha = 99;\n", "utf-8");
      const vecA2 = unitVector(8, 2);
      const embeddings = mockEmbeddings({
        "export const alpha = 99;": vecA2,
      });

      const updated = await applyIncrementalFileChanges({
        root,
        content: ["code"],
        embeddings,
        chunks,
        semanticIndex: semantic,
        relativePaths: ["src/a.ts"],
      });

      expect(updated.chunks).toHaveLength(2);
      const updatedA = updated.chunks.find((c) => c.file_path === "src/a.ts");
      const updatedB = updated.chunks.find((c) => c.file_path === "src/b.ts");
      expect(updatedA?.content).toContain("99");
      expect(updatedB?.content).toContain("beta");
      expect(updated.semantic.size).toBe(2);
      expect(updated.bm25).toBeInstanceOf(BM25Index);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applyIncrementalFileChanges removes deleted file chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-inc-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "a\n", "utf-8");

      const chunks: Chunk[] = [
        {
          content: "a",
          file_path: "src/a.ts",
          start_line: 1,
          end_line: 1,
          language: "typescript",
        },
        {
          content: "b",
          file_path: "src/b.ts",
          start_line: 1,
          end_line: 1,
          language: "typescript",
        },
      ];
      const semantic = new VectorIndex([unitVector(4, 0), unitVector(4, 1)]);

      const updated = await applyIncrementalFileChanges({
        root,
        content: ["code"],
        embeddings: mockEmbeddings({}),
        chunks,
        semanticIndex: semantic,
        relativePaths: ["src/b.ts"],
      });

      expect(updated.chunks).toHaveLength(1);
      expect(updated.chunks[0]?.file_path).toBe("src/a.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
