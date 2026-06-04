import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { computeSourceCacheKey } from "../src/utils.ts";
import { unitVector } from "./test-helpers.ts";

function hashToVector(text: string, dim = 32): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + (text.charCodeAt(i) ?? 0)) >>> 0;
  }
  return unitVector(dim, h % dim);
}

function trackingEmbeddings(): EmbeddingBackend & {
  documentEmbedCount: number;
  lastEmbeddedTexts: string[];
  resetEmbedCount(): void;
} {
  const state = { documentEmbedCount: 0, lastEmbeddedTexts: [] as string[] };
  return {
    model: "mock-track",
    dimensions: 32,
    get documentEmbedCount() {
      return state.documentEmbedCount;
    },
    get lastEmbeddedTexts() {
      return state.lastEmbeddedTexts;
    },
    resetEmbedCount() {
      state.documentEmbedCount = 0;
      state.lastEmbeddedTexts = [];
    },
    async embedDocuments(texts: string[]) {
      state.documentEmbedCount += texts.length;
      state.lastEmbeddedTexts = [...texts];
      return texts.map((text) => hashToVector(text));
    },
    async embedQuery(text: string) {
      return hashToVector(text);
    },
  };
}

type CacheEntryInternal = {
  index: MiruIndex | null;
  task: Promise<MiruIndex> | null;
  pendingPaths: Set<string>;
  updateChain: Promise<void>;
};

type IndexCacheTestAccess = {
  ensureEntry(cacheKey: string): CacheEntryInternal;
  noteFileChange(source: string, filename: string | null | undefined): void;
};

function cacheInternals(cache: IndexCache): IndexCacheTestAccess {
  return cache as unknown as IndexCacheTestAccess;
}

async function waitForEmbeddings(
  embeddings: { documentEmbedCount: number },
  entry: CacheEntryInternal,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await entry.updateChain.catch(() => undefined);
    if (embeddings.documentEmbedCount > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for incremental embed (${embeddings.documentEmbedCount} embeds)`,
  );
}

async function buildTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miru-inc-int-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/auth.ts"),
    "export function authenticateUser() {\n  return 'miruAuthSecretToken';\n}\n",
    "utf-8",
  );
  await writeFile(
    join(root, "src/utils.ts"),
    "export function formatDate() {\n  return 'miruUtilsCalendarHelper';\n}\n",
    "utf-8",
  );
  return root;
}

describe("incremental integration", () => {
  test("MiruIndex.applyFileChanges updates search results without re-embedding unchanged files", async () => {
    const root = await buildTempRepo();
    try {
      const embeddings = trackingEmbeddings();
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

      const initialEmbedCount = embeddings.documentEmbedCount;
      expect(initialEmbedCount).toBeGreaterThan(0);

      const before = await index.search({
        query: "miruAuthSecretToken",
        topK: 3,
        alpha: 0,
        rerank: false,
      });
      expect(before[0]?.chunk.file_path).toBe("src/auth.ts");

      await writeFile(
        join(root, "src/auth.ts"),
        "export function authenticateUser() {\n  return 'miruAuthRotatedToken';\n}\n",
        "utf-8",
      );

      embeddings.resetEmbedCount();
      await index.applyFileChanges(["src/auth.ts"]);

      expect(embeddings.documentEmbedCount).toBeGreaterThan(0);
      expect(embeddings.documentEmbedCount).toBeLessThan(initialEmbedCount);
      expect(
        embeddings.lastEmbeddedTexts.every((text) => text.includes("miruAuthRotatedToken")),
      ).toBe(true);
      expect(
        embeddings.lastEmbeddedTexts.some((text) => text.includes("miruUtilsCalendarHelper")),
      ).toBe(false);

      const after = await index.search({
        query: "miruAuthRotatedToken",
        topK: 3,
        alpha: 0,
        rerank: false,
      });
      expect(after[0]?.chunk.file_path).toBe("src/auth.ts");
      expect(after[0]?.chunk.content).toContain("miruAuthRotatedToken");

      const utilsStill = await index.search({
        query: "miruUtilsCalendarHelper",
        topK: 1,
        alpha: 0,
        rerank: false,
      });
      expect(utilsStill[0]?.chunk.file_path).toBe("src/utils.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("IndexCache flushes batched file changes incrementally", async () => {
    const root = await buildTempRepo();
    try {
      const embeddings = trackingEmbeddings();
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

      const cache = new IndexCache(["code"]);
      const cacheKey = computeSourceCacheKey(root);
      const internals = cacheInternals(cache);
      const entry = internals.ensureEntry(cacheKey);
      entry.index = index;
      entry.task = Promise.resolve(index);

      await writeFile(
        join(root, "src/auth.ts"),
        "export function authenticateUser() {\n  return 'miruCacheFlushToken';\n}\n",
        "utf-8",
      );
      await writeFile(
        join(root, "src/utils.ts"),
        "export function formatDate() {\n  return 'miruCacheUtilsUpdated';\n}\n",
        "utf-8",
      );

      embeddings.resetEmbedCount();
      internals.noteFileChange(root, "src/auth.ts");
      internals.noteFileChange(root, "src/utils.ts");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await entry.updateChain;

      expect(embeddings.documentEmbedCount).toBeGreaterThan(0);
      expect(
        embeddings.lastEmbeddedTexts.some((text) => text.includes("miruCacheFlushToken")),
      ).toBe(true);
      expect(
        embeddings.lastEmbeddedTexts.some((text) => text.includes("miruCacheUtilsUpdated")),
      ).toBe(true);

      const authHit = await index.search({
        query: "miruCacheFlushToken",
        topK: 1,
        alpha: 0,
        rerank: false,
      });
      expect(authHit[0]?.chunk.file_path).toBe("src/auth.ts");

      cache.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(
    "IndexCache watcher triggers incremental update on file write",
    async () => {
      const root = await buildTempRepo();
      const resolvedRoot = resolve(root);
      try {
        const embeddings = trackingEmbeddings();
        const built = await createIndexFromPath(resolvedRoot, embeddings, ["code"], resolvedRoot);
        const index = new MiruIndex({
          embeddings,
          bm25Index: built.bm25,
          semanticIndex: built.semantic,
          chunks: built.chunks,
          embeddingModel: embeddings.model,
          root: resolvedRoot,
          content: ["code"],
        });

        const cache = new IndexCache(["code"]);
        const cacheKey = computeSourceCacheKey(resolvedRoot);
        const internals = cacheInternals(cache);
        const entry = internals.ensureEntry(cacheKey);
        entry.index = index;
        entry.task = Promise.resolve(index);

        cache.startWatcher(resolvedRoot);
        await new Promise((r) => setTimeout(r, 100));

        embeddings.resetEmbedCount();
        const authPath = join(resolvedRoot, "src/auth.ts");
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          await writeFile(
            authPath,
            `export function authenticateUser() {\n  return 'miruWatchEventToken${attempt}';\n}\n`,
            "utf-8",
          );
          try {
            await waitForEmbeddings(embeddings, entry, 2000);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
        }
        if (lastError) {
          throw lastError;
        }

        const hit = await index.search({
          query: "miruWatchEventToken",
          topK: 1,
          alpha: 0,
          rerank: false,
        });
        expect(hit[0]?.chunk.file_path).toBe("src/auth.ts");
        expect(hit[0]?.chunk.content).toContain("miruWatchEventToken");

        cache.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: 20_000 },
  );
});
