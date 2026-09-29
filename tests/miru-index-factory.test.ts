import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { MiruIndex } from "../src/miru-index.ts";
import type { Chunk } from "../src/types.ts";

const chunk: Chunk = {
  content: "export const answer = 42;",
  file_path: "src/a.ts",
  start_line: 1,
  end_line: 1,
  language: "typescript",
};
const embeddings: EmbeddingBackend = {
  model: "offline",
  dimensions: 2,
  embedDocuments: async () => [],
  embedQuery: async () => new Float32Array([0, 0]),
};
const build = {
  bm25: {} as never,
  semantic: {} as never,
  chunks: [chunk],
};

describe("MiruIndex factories", () => {
  test("validates local paths and builds an index for a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-factory-"));
    try {
      await mkdir(join(root, "src"));
      const calls: unknown[][] = [];
      const index = await MiruIndex.fromPath(root, ["code"], "offline", {
        getValidatedCache: async (path, model, content) => {
          calls.push([path, model, content]);
          return null;
        },
        getEmbeddingBackend: () => embeddings,
        createIndexFromPath: (async (...args: unknown[]) => {
          calls.push(args);
          return build;
        }) as never,
      });
      expect(index.root).toBe(root);
      expect(index.chunks).toEqual([chunk]);
      expect(calls[0]).toEqual([root, "offline", ["code"]]);
      await expect(MiruIndex.fromPath(join(root, "missing"), [], "offline")).rejects.toThrow(
        "Path does not exist",
      );
      await Bun.write(join(root, "not-dir"), "file");
      await expect(MiruIndex.fromPath(join(root, "not-dir"), [], "offline")).rejects.toThrow(
        "Path is not a directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fromSource routes a local directory through the path factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-source-"));
    try {
      const index = await MiruIndex.fromSource(root, ["code"], "offline", undefined, {
        getValidatedCache: async () => null,
        getEmbeddingBackend: () => embeddings,
        createIndexFromPath: (async () => build) as never,
      });
      expect(index.root).toBe(root);
      expect(index.chunks).toEqual([chunk]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hydrates a compatible disk cache without rebuilding", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-cache-"));
    try {
      const loadCachedIndex = async () => ({
        bm25: {} as never,
        semantic: {} as never,
        chunks: [chunk],
        metadata: { root_path: root, content_type: ["docs"], file_mtimes: { "src/a.ts": 123 } },
      });
      const dependencies = {
        getValidatedCache: async () => "/cache/bundle",
        loadCachedIndex: loadCachedIndex as never,
        getEmbeddingBackend: () => embeddings,
      };
      const local = await MiruIndex.fromPath(root, ["code"], "offline", dependencies);
      expect(local.loadedFromDisk).toBe(true);
      expect(local.root).toBe(root);
      expect(local.contentTypes).toEqual(["docs"]);
      expect(local.getStoredFileMtimes().get("src/a.ts")).toBe(123);

      const remote = await MiruIndex.fromGit(
        "https://example.test/repo",
        ["code"],
        "offline",
        null,
        dependencies,
      );
      expect(remote.loadedFromDisk).toBe(true);
      expect(remote.root).toBe(root);
      expect(
        await MiruIndex.loadFromDisk("/cache/bundle", "offline", {
          ...dependencies,
          loadCachedIndex: (async () => ({
            bm25: {} as never,
            semantic: {} as never,
            chunks: [],
            metadata: {},
          })) as never,
        }),
      ).toBeInstanceOf(MiruIndex);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("builds remote indexes, saves them, and always removes temporary clones", async () => {
    const cloneDir = await mkdtemp(join(tmpdir(), "miru-index-clone-"));
    const trace: string[] = [];
    const index = await MiruIndex.fromGit(
      "https://example.test/org/repo",
      ["code"],
      "offline",
      "main",
      {
        getValidatedCache: async () => null,
        cloneGitRepository: async (url, ref) => {
          trace.push(`${url}:${ref}`);
          return cloneDir;
        },
        getEmbeddingBackend: () => embeddings,
        createIndexFromPath: (async () => build) as never,
        findIndexCachePath: (key) => {
          trace.push(key);
          return "/tmp/index-cache";
        },
        saveBuiltIndex: async (saved, path) => {
          expect(saved.root).toBeNull();
          trace.push(path);
        },
      },
    );
    expect(index.root).toBeNull();
    expect(index.chunks).toEqual([chunk]);
    expect(trace[0]).toContain(":main");
    expect(trace.at(-1)).toBe("/tmp/index-cache");
    expect(await Bun.file(cloneDir).exists()).toBe(false);
  });

  test("uses the default built-index saver for a remote index", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-default-save-"));
    const cloneDir = join(root, "clone");
    const output = join(root, "bundle");
    await mkdir(cloneDir);
    try {
      await MiruIndex.fromGit("https://example.test/default-saver", ["code"], "offline", null, {
        getValidatedCache: async () => null,
        cloneGitRepository: async () => cloneDir,
        getEmbeddingBackend: () => embeddings,
        createIndexFromPath: (async () => ({
          bm25: new BM25Index(),
          semantic: new VectorIndex([new Float32Array([1, 0])]),
          chunks: [chunk],
        })) as never,
        findIndexCachePath: () => output,
      });
      expect(await Bun.file(join(output, "metadata.json")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a temporary clone if index creation fails", async () => {
    const cloneDir = await mkdtemp(join(tmpdir(), "miru-index-clone-fail-"));
    await expect(
      MiruIndex.fromGit("https://example.test/org/repo", ["code"], "offline", null, {
        getValidatedCache: async () => null,
        cloneGitRepository: async () => cloneDir,
        getEmbeddingBackend: () => embeddings,
        createIndexFromPath: (async () => {
          throw new Error("build failed");
        }) as never,
      }),
    ).rejects.toThrow("build failed");
    expect(await Bun.file(cloneDir).exists()).toBe(false);
  });
});
