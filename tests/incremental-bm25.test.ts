import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chunkSource } from "../src/chunking/chunking.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { detectLanguage } from "../src/index/files.ts";
import { applyIncrementalFileChanges } from "../src/index/incremental.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import type { Chunk } from "../src/types.ts";
import { unitVector } from "./test-helpers.ts";

const backend: EmbeddingBackend = {
  model: "mock",
  dimensions: 4,
  async embedDocuments(texts) {
    return texts.map((_, i) => unitVector(4, i % 4));
  },
  async embedQuery() {
    return unitVector(4, 0);
  },
};

const fn = (name: string, extra: string, lines = 30): string =>
  `export function ${name}(x: number): number {\n${Array.from({ length: lines }, (_, j) => `  const ${name}${j} = x * ${j}; // ${extra}`).join("\n")}\n  return x;\n}\n`;

/** Several multi-chunk files, so removed docs sit before, between and after kept ones. */
const initial: Record<string, string> = {
  "src/a.ts": fn("alpha", "first") + fn("alphaTwo", "first"),
  "src/b.ts": fn("beta", "second") + fn("betaTwo", "second"),
  "src/c.ts": fn("gamma", "third") + fn("gammaTwo", "third"),
  "docs/d.md": `# Delta\n\n${"delta paragraph text.\n".repeat(80)}`,
};

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), source, "utf-8");
  }
}

async function chunkAll(root: string, files: Record<string, string>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (const [rel, source] of Object.entries(files)) {
    chunks.push(...(await chunkSource(source, rel, detectLanguage(join(root, rel)))));
  }
  return chunks;
}

async function scenario(
  mutate: (files: Record<string, string>) => Promise<{ changed: string[] }> | { changed: string[] },
) {
  const root = await mkdtemp(join(tmpdir(), "miru-bm25-"));
  try {
    const files = { ...initial };
    await write(root, files);
    const chunks = await chunkAll(root, files);
    const bm25 = buildBm25FromChunks(chunks);
    const before = JSON.stringify(bm25.toJSON());
    const semanticIndex = new VectorIndex(chunks.map((_, i) => unitVector(4, i % 4)));

    const { changed } = await mutate(files);
    await write(root, files);
    for (const rel of Object.keys(initial)) {
      if (!(rel in files)) {
        await unlink(join(root, rel)).catch(() => undefined);
      }
    }

    const result = await applyIncrementalFileChanges({
      root,
      content: ["code", "docs"],
      embeddings: backend,
      chunks,
      semanticIndex,
      bm25,
      relativePaths: changed,
    });

    const fresh = buildBm25FromChunks(result.chunks);
    expect(result.bm25.toJSON()).toEqual(fresh.toJSON());
    for (const query of [["alpha"], ["gamma", "third"], ["delta", "paragraph"], ["brandnew"]]) {
      expect(result.bm25.getScores(query)).toEqual(fresh.getScores(query));
    }
    // The previous index must be untouched: in-flight searches may still hold it.
    expect(JSON.stringify(bm25.toJSON())).toBe(before);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("incremental BM25 update matches a full rebuild", () => {
  test("edit a file in the middle", async () => {
    await scenario((f) => {
      f["src/b.ts"] = fn("beta", "edited") + fn("betaTwo", "second");
      return { changed: ["src/b.ts"] };
    });
  });

  test("edit the first and last files", async () => {
    await scenario((f) => {
      f["src/a.ts"] = fn("alpha", "edited") + fn("alphaTwo", "first");
      f["docs/d.md"] = `# Delta\n\n${"delta changed text.\n".repeat(80)}`;
      return { changed: ["src/a.ts", "docs/d.md"] };
    });
  });

  test("delete the first file so every later doc shifts down", async () => {
    await scenario((f) => {
      delete f["src/a.ts"];
      return { changed: ["src/a.ts"] };
    });
  });

  test("add a new file", async () => {
    await scenario((f) => {
      f["src/new.ts"] = fn("brandnew", "added");
      return { changed: ["src/new.ts"] };
    });
  });

  test("a file shrinking to fewer chunks and another growing", async () => {
    await scenario((f) => {
      f["src/c.ts"] = fn("gamma", "third", 5);
      f["src/b.ts"] = fn("beta", "second") + fn("betaTwo", "second") + fn("betaThree", "x", 60);
      return { changed: ["src/b.ts", "src/c.ts"] };
    });
  });

  test("touching a file without changing it", async () => {
    await scenario(() => ({ changed: ["src/b.ts"] }));
  });

  test("an index of the wrong size is ignored and rebuilt from the chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-bm25-"));
    try {
      await write(root, initial);
      const chunks = await chunkAll(root, initial);
      const semanticIndex = new VectorIndex(chunks.map((_, i) => unitVector(4, i % 4)));
      const stale = new BM25Index();
      stale.addDocument(["unrelated"]);
      const result = await applyIncrementalFileChanges({
        root,
        content: ["code", "docs"],
        embeddings: backend,
        chunks,
        semanticIndex,
        bm25: stale,
        relativePaths: ["src/b.ts"],
      });
      expect(result.bm25.toJSON()).toEqual(buildBm25FromChunks(result.chunks).toJSON());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("BM25Index.withoutDocuments", () => {
  const docs = [["a", "b"], ["b", "c"], ["a", "c", "c"], ["d"]];
  const build = (list: string[][]): BM25Index => {
    const index = new BM25Index();
    for (const doc of list) {
      index.addDocument(doc);
    }
    return index;
  };

  test("equals indexing only the surviving docs", () => {
    for (const removed of [[], [0], [1, 2], [3], [0, 1, 2, 3]]) {
      const survivors = docs.filter((_, i) => !removed.includes(i));
      expect(build(docs).withoutDocuments(new Set(removed)).toJSON()).toEqual(
        build(survivors).toJSON(),
      );
    }
  });

  test("can keep indexing after removal, without touching the source index", () => {
    const source = build(docs);
    const before = JSON.stringify(source.toJSON());
    const next = source.withoutDocuments(new Set([1]));
    next.addDocument(["a", "e"]);
    expect(next.toJSON()).toEqual(
      build([docs[0], docs[2], docs[3], ["a", "e"]] as string[][]).toJSON(),
    );
    expect(JSON.stringify(source.toJSON())).toBe(before);
  });
});
