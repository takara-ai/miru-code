import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchmarkSearchComparison } from "../src/benchmark/compare.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { unitVector } from "./test-helpers.ts";

function hashToVector(text: string, dim = 32): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + (text.charCodeAt(i) ?? 0)) >>> 0;
  }
  return unitVector(dim, h % dim);
}

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-benchmark-paths",
    dimensions: 32,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => hashToVector(text));
    },
    async embedQuery(text: string) {
      return hashToVector(text);
    },
  };
}

async function buildTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miru-bench-paths-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/auth.ts"),
    [
      "export function authenticateUser(token: string) {",
      "  return token === 'miruAuthSecretToken';",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  return resolve(root);
}

async function buildIndex(root: string): Promise<MiruIndex> {
  const embeddings = mockEmbeddings();
  const built = await createIndexFromPath(root, embeddings, ["code"], root);
  return new MiruIndex({
    embeddings,
    bm25Index: built.bm25,
    semanticIndex: built.semantic,
    chunks: built.chunks,
    embeddingModel: embeddings.model,
    root,
    content: ["code"],
  });
}

describe("benchmarkSearchComparison path identity", () => {
  test("canonicalizes absolute Miru paths against relative Grep for accuracy", async () => {
    const root = await buildTempRepo();
    try {
      const index = await buildIndex(root);
      const authChunk = index.chunks.find((c) => c.file_path.includes("auth"));
      expect(authChunk).toBeDefined();
      if (!authChunk) {
        throw new Error("expected auth chunk");
      }

      // Grep emits repo-relative paths; force Miru to emit an absolute path for the same file.
      index.search = async () => [
        {
          score: 1,
          chunk: {
            ...authChunk,
            file_path: join(root, authChunk.file_path),
          },
        },
      ];

      const { benchmark } = await benchmarkSearchComparison({
        query: "authenticateUser miruAuthSecretToken",
        repoPath: root,
        index,
        topK: 3,
        relevant: ["./src/auth.ts", "src/auth.ts"],
      });

      expect(benchmark.miru.top_file).toBe("src/auth.ts");
      expect(benchmark.grep_read.top_file).toBe("src/auth.ts");
      expect(benchmark.accuracy.rank1_match).toBe(true);
      expect(benchmark.accuracy.miru_only).toEqual([]);
      expect(benchmark.accuracy.grep_only).toEqual([]);
      expect(benchmark.accuracy.top_k_overlap_pct).toBe(100);
      expect(benchmark.accuracy.labeled_recall).toEqual({ miru: true, grep: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes ./ and backslash variants for labeled recall", async () => {
    const root = await buildTempRepo();
    try {
      const index = await buildIndex(root);
      const authChunk = index.chunks.find((c) => c.file_path.includes("auth"));
      expect(authChunk).toBeDefined();
      if (!authChunk) {
        throw new Error("expected auth chunk");
      }

      index.search = async () => [
        {
          score: 1,
          chunk: {
            ...authChunk,
            file_path: `.\\src\\auth.ts`,
          },
        },
      ];

      const { benchmark } = await benchmarkSearchComparison({
        query: "authenticateUser miruAuthSecretToken",
        repoPath: root,
        index,
        topK: 3,
        relevant: [".\\src\\auth.ts"],
      });

      expect(benchmark.miru.top_file).toBe("src/auth.ts");
      expect(benchmark.accuracy.rank1_match).toBe(true);
      expect(benchmark.accuracy.labeled_recall?.miru).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
