import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import { findIndexCachePath, loadValidatedCache } from "../src/cache.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { persistencePaths, saveIndexBundle } from "../src/index/persistence.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { indexCacheEpoch } from "../src/version.ts";

const EMBEDDING_MODEL = "ds1-miru-int8";

describe("index cache epoch", () => {
  let cacheRoot = "";
  let previousCacheHome: string | undefined;

  afterEach(async () => {
    if (cacheRoot) {
      await rm(cacheRoot, { recursive: true, force: true });
      cacheRoot = "";
    }
    if (previousCacheHome === undefined) {
      delete process.env.MIRU_CACHE_HOME;
    } else {
      process.env.MIRU_CACHE_HOME = previousCacheHome;
    }
  });

  async function seedStaleCache(epoch: string): Promise<string> {
    previousCacheHome = process.env.MIRU_CACHE_HOME;
    cacheRoot = join(tmpdir(), `miru-cache-epoch-${Date.now()}`);
    process.env.MIRU_CACHE_HOME = cacheRoot;

    const repo = join(cacheRoot, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "sample.ts"), "export const x = 1;\n");

    const indexPath = findIndexCachePath(repo);
    const paths = persistencePaths(indexPath);
    await mkdir(paths.root, { recursive: true });
    await saveIndexBundle({
      paths,
      bm25: new BM25Index(),
      semantic: QuantizedVectorIndex.fromPersisted(new Int8Array(0), new Float32Array(0), 0, 256),
      chunks: [],
      metadata: {
        index_epoch: epoch,
        content_type: ["code"],
        embedding_model: EMBEDDING_MODEL,
        embedding_dimensions: 256,
        root_path: resolve(repo),
        file_paths: ["sample.ts"],
      },
    });
    return repo;
  }

  test("indexCacheEpoch is zero-copy from package.json", () => {
    const [major, minor] = packageJson.version.split(".");
    const expected = major === "0" ? `0.${minor}` : major;
    expect(indexCacheEpoch()).toBe(expected);
  });

  test("stale epoch cache is rejected without deleting cache files during a read", async () => {
    const repo = await seedStaleCache("0.6");
    const indexPath = findIndexCachePath(repo);
    expect(await Bun.file(join(indexPath, "metadata.json")).exists()).toBe(true);

    const validated = await loadValidatedCache(repo, EMBEDDING_MODEL, ["code"]);
    expect(validated).toBeNull();
    expect(await Bun.file(join(indexPath, "metadata.json")).exists()).toBe(true);
  });

  test("matching epoch cache is accepted", async () => {
    const repo = await seedStaleCache(indexCacheEpoch());
    const validated = await loadValidatedCache(repo, EMBEDDING_MODEL, ["code"]);
    expect(validated?.metadata.index_epoch).toBe(indexCacheEpoch());
  });
});
