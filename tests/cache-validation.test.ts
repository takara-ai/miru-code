import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCache,
  findIndexCachePath,
  getValidatedCache,
  loadCachedIndex,
  resolveCacheFolder,
} from "../src/cache.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { persistencePaths, saveIndexBundle } from "../src/index/persistence.ts";
import { buildSemanticIndex, resolveSemanticStorage } from "../src/index/vector-storage.ts";
import { indexCacheEpoch } from "../src/version.ts";

const MODEL = "ds1-miru-int8";
let cacheHome: string | undefined;
let oldCacheHome: string | undefined;
let oldFloatVectors: string | undefined;
afterEach(async () => {
  if (cacheHome) await rm(cacheHome, { recursive: true, force: true });
  cacheHome = undefined;
  if (oldCacheHome === undefined) delete process.env.MIRU_CACHE_HOME;
  else process.env.MIRU_CACHE_HOME = oldCacheHome;
  if (oldFloatVectors === undefined) delete process.env.MIRU_FLOAT_VECTORS;
  else process.env.MIRU_FLOAT_VECTORS = oldFloatVectors;
});

async function seed(
  name: string,
): Promise<{ source: string; indexPath: string; paths: ReturnType<typeof persistencePaths> }> {
  if (!cacheHome) {
    oldCacheHome = process.env.MIRU_CACHE_HOME;
    oldFloatVectors = process.env.MIRU_FLOAT_VECTORS;
    cacheHome = await mkdtemp(join(tmpdir(), "miru-cache-validation-"));
    process.env.MIRU_CACHE_HOME = cacheHome;
    delete process.env.MIRU_FLOAT_VECTORS;
  }
  const source = join(cacheHome, name);
  const indexPath = findIndexCachePath(source);
  const paths = persistencePaths(indexPath);
  await mkdir(paths.root, { recursive: true });
  const storage = resolveSemanticStorage();
  const semantic = buildSemanticIndex([new Float32Array(256)]);
  await saveIndexBundle({
    paths,
    bm25: new BM25Index(),
    semantic,
    chunks: [],
    metadata: {
      index_epoch: indexCacheEpoch(),
      content_type: ["code"],
      embedding_model: MODEL,
      embedding_dimensions: 256,
      vector_storage: storage,
      root_path: null,
      file_paths: [],
    },
  });
  return { source, indexPath, paths };
}

function currentCacheHome(): string {
  if (!cacheHome) throw new Error("cache home has not been initialized");
  return cacheHome;
}

async function patchMetadata(path: string, patch: Record<string, unknown>): Promise<void> {
  const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...metadata, ...patch }));
}

describe("validated cache bundles", () => {
  test("resolves an override root, accepts compatible bundles, and hydrates them", async () => {
    const { source, indexPath } = await seed("valid");
    expect(resolveCacheFolder()).toBe(currentCacheHome());
    expect(await getValidatedCache(source, MODEL, ["code"])).toBe(indexPath);
    const cached = await loadCachedIndex(indexPath);
    expect(cached.chunks).toEqual([]);
    expect(cached.metadata.embedding_model).toBe(MODEL);
    await clearCache(source);
    expect(await Bun.file(indexPath).exists()).toBe(false);
    await clearCache(source);
  });

  test("resolves cache folder conventions for Windows, macOS, and Unix", () => {
    const names = [
      "MIRU_CACHE_HOME",
      "HOME",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "LOCALAPPDATA",
      "APPDATA",
    ] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.MIRU_CACHE_HOME = "";
      process.env.HOME = "/home/miru";
      delete process.env.USERPROFILE;
      expect(resolveCacheFolder("darwin")).toBe("/home/miru/Library/Caches/miru");
      process.env.XDG_CACHE_HOME = "/cache-root";
      expect(resolveCacheFolder("linux")).toBe("/cache-root/miru");
      delete process.env.XDG_CACHE_HOME;
      expect(resolveCacheFolder("linux")).toBe("/home/miru/.cache/miru");
      process.env.LOCALAPPDATA = "C:/Users/miru/Local";
      expect(resolveCacheFolder("win32")).toBe("C:/Users/miru/Local/miru/Cache");
      delete process.env.LOCALAPPDATA;
      process.env.APPDATA = "C:/Users/miru/Roaming";
      expect(resolveCacheFolder("win32")).toBe("C:/Users/miru/Roaming/miru/Cache");
      delete process.env.APPDATA;
      expect(resolveCacheFolder("win32")).toBe("/home/miru/AppData/Local/miru/Cache");
      process.env.MIRU_CACHE_HOME = "/override";
      expect(resolveCacheFolder("linux")).toBe("/override");
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("rejects metadata model, dimensions, storage, content, and shape mismatches", async () => {
    const model = await seed("model");
    expect(await getValidatedCache(model.source, "other-model", ["code"])).toBeNull();

    const dimensions = await seed("dimensions");
    await patchMetadata(dimensions.paths.metadata, { embedding_dimensions: 12 });
    expect(await getValidatedCache(dimensions.source, MODEL, ["code"])).toBeNull();

    const storage = await seed("storage");
    await patchMetadata(storage.paths.metadata, { vector_storage: "float32" });
    expect(await getValidatedCache(storage.source, MODEL, ["code"])).toBeNull();

    const content = await seed("content");
    expect(await getValidatedCache(content.source, MODEL, ["code", "docs"])).toBeNull();
    expect(await getValidatedCache(content.source, MODEL, ["docs"])).toBeNull();

    const invalidContent = await seed("invalid-content");
    await patchMetadata(invalidContent.paths.metadata, { content_type: 4 });
    expect(await getValidatedCache(invalidContent.source, MODEL, ["code"])).toBeNull();

    const semanticDims = await seed("semantic-dimensions");
    await Bun.write(
      join(semanticDims.paths.semanticIndex, "meta.json"),
      JSON.stringify({ storage: "int8", dimensions: 12, count: 0 }),
    );
    expect(await getValidatedCache(semanticDims.source, MODEL, ["code"])).toBeNull();

    const semanticStorage = await seed("semantic-storage");
    await Bun.write(
      join(semanticStorage.paths.semanticIndex, "meta.json"),
      JSON.stringify({ storage: "float32", dimensions: 256, count: 0 }),
    );
    expect(await getValidatedCache(semanticStorage.source, MODEL, ["code"])).toBeNull();
  });

  test("rejects missing root paths and missing files listed in the cache", async () => {
    const missingRoot = await seed("missing-root");
    await patchMetadata(missingRoot.paths.metadata, {
      root_path: join(currentCacheHome(), "absent-root"),
    });
    expect(await getValidatedCache(missingRoot.source, MODEL, ["code"])).toBeNull();

    const missingFile = await seed("missing-file");
    const repo = join(currentCacheHome(), "repo");
    await mkdir(repo, { recursive: true });
    await patchMetadata(missingFile.paths.metadata, { root_path: repo, file_paths: ["gone.ts"] });
    expect(await getValidatedCache(missingFile.source, MODEL, ["code"])).toBeNull();
  });
});
