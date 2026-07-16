import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkLocateComparison } from "../src/benchmark/locate-compare.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { countTokens } from "../src/token-count.ts";
import { unitVector } from "./test-helpers.ts";

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-locate-bench",
    dimensions: 8,
    async embedDocuments(texts: string[]) {
      return texts.map((_, i) => unitVector(8, i % 8));
    },
    async embedQuery(text: string) {
      return unitVector(8, text.length % 8);
    },
  };
}

describe("locate benchmark comparison", () => {
  test("locate payload is cheaper than agent-style Grep and attaches savings", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-locate-bench-"));
    try {
      await writeFile(
        join(root, "app.ts"),
        [
          "export const DATABASE_URL = process.env.DATABASE_URL;",
          "export function connect() {",
          "  return DATABASE_URL;",
          "}",
          "",
        ].join("\n"),
        "utf-8",
      );

      const embeddings = mockEmbeddings();
      const built = await createIndexFromPath(root, embeddings, ["code"], root);
      const index = new MiruIndex({
        embeddings,
        bm25Index: built.bm25,
        semanticIndex: built.semantic,
        chunks: built.chunks,
        embeddingModel: embeddings.model,
        root,
        content: ["code"],
      });

      const comparison = await benchmarkLocateComparison({
        literal: "DATABASE_URL",
        repoPath: root,
        index,
        locate: { mode: "locations", limit: 10 },
      });

      expect(comparison.result.n).toBeGreaterThan(0);
      expect(comparison.benchmark.miru_tok).toBe(countTokens(JSON.stringify(comparison.payload)));
      expect(comparison.benchmark.grep_tok).toBeGreaterThan(comparison.benchmark.miru_tok);
      expect(comparison.benchmark.saved_tok).toBe(
        comparison.benchmark.grep_tok - comparison.benchmark.miru_tok,
      );
      expect(comparison.benchmark.save_pct).toBeGreaterThan(0);
      expect(comparison.benchmark.rank1).toBe(true);
      expect(comparison.payload.benchmark).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes match_variants/include/exclude/context_lines through to the real locate call", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-locate-bench-opts-"));
    try {
      await writeFile(
        join(root, "app.ts"),
        ["const rateLimit = 1;", "const unrelated = 2;", "const rate_limit_window = 3;", ""].join(
          "\n",
        ),
        "utf-8",
      );
      await writeFile(join(root, "other.ts"), "const rateLimit = 99;\n", "utf-8");

      const embeddings = mockEmbeddings();
      const built = await createIndexFromPath(root, embeddings, ["code"], root);
      const index = new MiruIndex({
        embeddings,
        bm25Index: built.bm25,
        semanticIndex: built.semantic,
        chunks: built.chunks,
        embeddingModel: embeddings.model,
        root,
        content: ["code"],
      });

      const comparison = await benchmarkLocateComparison({
        literal: "rateLimit",
        repoPath: root,
        index,
        locate: {
          mode: "lines",
          match_variants: true,
          include: ["app.ts"],
          context_lines: 1,
        },
      });

      // match_variants must have found rate_limit_window too, and include must have
      // dropped other.ts — if these options were silently ignored, n would differ.
      expect(comparison.result.n).toBe(2);
      expect(comparison.result.hits.every((h) => h.file_path === "app.ts")).toBe(true);
      expect(comparison.result.hits[0]?.context).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("grep baseline widens to match a requested context_lines instead of a fixed default", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-locate-bench-ctx-"));
    try {
      // 5 unique lines either side of the match so -C 2 (default) and -C 5
      // (requested) produce genuinely different amounts of grep context.
      const lines = [
        "const pad0 = 0;",
        "const pad1 = 1;",
        "const pad2 = 2;",
        "const pad3 = 3;",
        "const pad4 = 4;",
        "const DATABASE_URL = process.env.DATABASE_URL;",
        "const pad5 = 5;",
        "const pad6 = 6;",
        "const pad7 = 7;",
        "const pad8 = 8;",
        "const pad9 = 9;",
        "",
      ];
      await writeFile(join(root, "app.ts"), lines.join("\n"), "utf-8");

      const embeddings = mockEmbeddings();
      const built = await createIndexFromPath(root, embeddings, ["code"], root);
      const index = new MiruIndex({
        embeddings,
        bm25Index: built.bm25,
        semanticIndex: built.semantic,
        chunks: built.chunks,
        embeddingModel: embeddings.model,
        root,
        content: ["code"],
      });

      const defaultContext = await benchmarkLocateComparison({
        literal: "DATABASE_URL",
        repoPath: root,
        index,
        locate: { mode: "lines" },
      });
      const wideContext = await benchmarkLocateComparison({
        literal: "DATABASE_URL",
        repoPath: root,
        index,
        locate: { mode: "lines", context_lines: 5 },
      });

      // If context_lines were still ignored by the grep baseline, both calls
      // would grep with the same fixed -C 2 and produce identical token counts.
      expect(wideContext.benchmark.grep_tok).toBeGreaterThan(defaultContext.benchmark.grep_tok);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
