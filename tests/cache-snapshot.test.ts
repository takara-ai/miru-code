import { expect, test } from "bun:test";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCachedIndex } from "../src/cache.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { type IndexBundle, loadIndexSnapshot, saveIndexSnapshot } from "../src/index/snapshot.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import type { Chunk } from "../src/types.ts";

function bundle(version: string, count: number, storage: "int8" | "float32"): IndexBundle {
  const chunks: Chunk[] = [];
  const vectors: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      content: version,
      file_path: `src/${version}-${i}.ts`,
      start_line: 1,
      end_line: 1,
      language: "typescript",
    });
    vectors.push(new Float32Array(i % 2 ? [0, 1] : [1, 0]));
  }
  return {
    bm25: buildBm25FromChunks(chunks),
    semantic: storage === "int8" ? new QuantizedVectorIndex(vectors) : new VectorIndex(vectors),
    chunks,
    metadata: { version },
  };
}

function expectBundle(actual: IndexBundle | null | undefined, expected: IndexBundle): void {
  expect(actual?.chunks).toEqual(expected.chunks);
  expect(actual?.metadata.version).toBe(expected.metadata.version);
  expect(actual?.bm25.toJSON()).toEqual(expected.bm25.toJSON());
  expect(actual?.semantic.size).toBe(expected.semantic.size);
  expect(actual?.semantic.dimensions).toBe(expected.semantic.dimensions);
  expect(actual?.semantic.query(new Float32Array([1, 0]), expected.chunks.length)).toEqual(
    expected.semantic.query(new Float32Array([1, 0]), expected.chunks.length),
  );
}

test("overlapping publications expose only complete snapshots and preserve in-flight reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-cache-snapshot-"));
  const original = bundle("original", 1, "int8");
  const first = bundle("first", 2, "int8");
  const second = bundle("second", 3, "float32");
  const firstPrepared = Promise.withResolvers<void>();
  const publishFirst = Promise.withResolvers<void>();
  const originalOpened = Promise.withResolvers<void>();
  const secondAttempted = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  try {
    await saveIndexSnapshot(root, original);
    const reader = loadIndexSnapshot(root, async () => {
      originalOpened.resolve();
      await resumeRead.promise;
      return true;
    });
    const writer = saveIndexSnapshot(root, first, async (temporary, destination) => {
      firstPrepared.resolve();
      await publishFirst.promise;
      await rename(temporary, destination);
    });
    let secondSave: Promise<void> | undefined;
    try {
      await Promise.all([firstPrepared.promise, originalOpened.promise]);
      expectBundle(await loadCachedIndex(root), original);
      secondSave = saveIndexSnapshot(root, second, async (temporary, destination) => {
        try {
          await rename(temporary, destination);
        } finally {
          secondAttempted.resolve();
        }
      });
      if (process.platform === "win32") {
        // The first rename may fail while the held reader is open. Releasing it
        // after that attempt allows the same publication to retry safely.
        await Promise.race([secondAttempted.promise, secondSave]);
        resumeRead.resolve();
      }
      await secondSave;
      expectBundle(await loadCachedIndex(root), second);
      resumeRead.resolve();
      expectBundle(await reader, original);
    } finally {
      resumeRead.resolve();
      // Let the second writer finish before publishing the first writer's snapshot.
      await Promise.allSettled([reader, secondSave]);
      publishFirst.resolve();
      await writer;
    }

    expectBundle(await loadCachedIndex(root), first);
    expect(await readdir(root)).toEqual(["snapshot.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed snapshot publication preserves the previous index and removes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-cache-snapshot-"));
  const original = bundle("original", 1, "int8");
  try {
    await saveIndexSnapshot(root, original);
    await expect(
      saveIndexSnapshot(root, bundle("failed", 2, "int8"), async () => {
        throw new Error("publish failed");
      }),
    ).rejects.toThrow("publish failed");

    expectBundle(await loadCachedIndex(root), original);
    expect(await readdir(root)).toEqual(["snapshot.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates snapshot headers and refuses to publish inconsistent indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-cache-snapshot-"));
  try {
    const path = join(root, "snapshot.bin");
    await writeFile(path, "INVALID_HDR");
    await expect(loadCachedIndex(root)).rejects.toThrow("Invalid index snapshot signature");
    const invalidShape = Buffer.from([2, 0, 0, 0, 123, 125]);
    await writeFile(path, Buffer.concat([Buffer.from("MIRU_IDX_2\n"), invalidShape]));
    await expect(loadCachedIndex(root)).rejects.toThrow("Invalid snapshot vector shape");

    const original = bundle("original", 1, "int8");
    await saveIndexSnapshot(root, original);
    await expect(saveIndexSnapshot(root, { ...original, chunks: [] })).rejects.toThrow(
      "does not have a BM25 entry and vector",
    );
    const invalidVectors = {
      size: original.semantic.size,
      dimensions: original.semantic.dimensions,
      memoryBytes: () => 0,
      query: () => ({ indices: [], distances: [] }),
    };
    await expect(
      saveIndexSnapshot(root, { ...original, semantic: invalidVectors }),
    ).rejects.toThrow("Unsupported semantic index type");
    expectBundle(await loadCachedIndex(root), original);
    expect(await readdir(root)).toEqual(["snapshot.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
