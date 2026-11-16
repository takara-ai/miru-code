/**
 * On-disk index cache: location resolution, cache-key hashing, validation, and load.
 *
 * Each indexed source (local directory path or git URL + ref) maps to a SHA-256
 * subdirectory under the Miru cache folder. `MiruIndex.fromPath` / `fromGit` call
 * `loadValidatedCache` before rebuilding.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveEmbeddingDimensions } from "./embeddings/openai.ts";
import { loadBm25, loadSemantic, pathsExist, persistencePaths } from "./index/persistence.ts";
import { type IndexBundle, loadIndexSnapshot } from "./index/snapshot.ts";
import { resolveSemanticStorage, semanticStorageFromMetadata } from "./index/vector-storage.ts";
import type { ContentType } from "./types.ts";
import { chunkFromDict } from "./types.ts";
import { computeSourceCacheKey } from "./utils.ts";
import { indexCacheEpoch } from "./version.ts";

/** Platform cache root; override with `MIRU_CACHE_HOME`. */
export function resolveCacheFolder(platform: NodeJS.Platform = process.platform): string {
  const override = process.env.MIRU_CACHE_HOME?.trim();
  if (override) {
    return override;
  }
  const name = "miru";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let base: string;
  if (platform === "win32") {
    base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(home, "AppData", "Local");
    base = join(base, name, "Cache");
  } else if (platform === "darwin") {
    base = join(home, "Library", "Caches", name);
  } else {
    base = process.env.XDG_CACHE_HOME
      ? join(process.env.XDG_CACHE_HOME, name)
      : join(home, ".cache", name);
  }
  return base;
}

/**
 * Path to the saved index bundle for a source.
 *
 * `path` is a resolved local directory or a git cache key (`url` or `url@ref`).
 * The on-disk folder name is SHA-256 of that key so paths stay short and safe.
 */
export function findIndexCachePath(path: string, ref?: string | null): string {
  const normalized = computeSourceCacheKey(path, ref);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalized);
  const subdir = hasher.digest("hex");
  return join(resolveCacheFolder(), subdir, "index");
}

/** True when saved metadata still matches the requested index configuration. */
function metadataMatches(
  metadata: Record<string, unknown>,
  embeddingModel: string,
  content: ContentType[],
): boolean {
  try {
    if (metadata.index_epoch !== indexCacheEpoch()) {
      return false;
    }
    const stored = metadata.content_type as ContentType[];
    const model = metadata.embedding_model as string;
    if (model !== embeddingModel) {
      return false;
    }
    const expectedDims = resolveEmbeddingDimensions(embeddingModel);
    const storedDims = metadata.embedding_dimensions as number | undefined;
    if (expectedDims != null && storedDims !== expectedDims) {
      return false;
    }
    if (semanticStorageFromMetadata(metadata) !== resolveSemanticStorage()) {
      return false;
    }
    const a = new Set(stored);
    const b = new Set(content);
    if (a.size !== b.size) {
      return false;
    }
    for (const c of a) {
      if (!b.has(c)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Read and validate a single snapshot before hydrating it. Unusable cache data is a miss. */
export async function loadValidatedCache(
  path: string,
  model: string,
  content: ContentType[],
): Promise<IndexBundle | null> {
  try {
    return await readCacheBundle(findIndexCachePath(path), async (metadata, shape) => {
      if (!metadataMatches(metadata, model, content)) return false;
      const expectedDims = resolveEmbeddingDimensions(model);
      if (expectedDims != null && shape.dimensions !== expectedDims) return false;
      if (shape.storage !== resolveSemanticStorage()) return false;

      const rootPath = metadata.root_path as string | null;
      if (rootPath) {
        await Bun.file(rootPath).stat();
        for (const rel of metadata.file_paths as string[]) {
          await Bun.file(join(rootPath, rel)).stat();
        }
      }
      return true;
    });
  } catch {
    return null;
  }
}

/** Explicit loads report disk and format errors to callers. */
export async function loadCachedIndex(indexPath: string): Promise<IndexBundle> {
  const bundle = await readCacheBundle(indexPath);
  if (!bundle) throw new Error(`No complete index bundle at ${indexPath}`);
  return bundle;
}

async function readCacheBundle(
  indexPath: string,
  accept?: Parameters<typeof loadIndexSnapshot>[1],
): Promise<IndexBundle | null> {
  const snapshot = await loadIndexSnapshot(indexPath, accept);
  if (snapshot !== undefined) return snapshot;

  // Older Miru releases stored the same components in separate files.
  const paths = persistencePaths(indexPath);
  if (accept && (await pathsExist(paths)).length > 0) return null;
  const metadata = JSON.parse(await Bun.file(paths.metadata).text()) as Record<string, unknown>;
  if (accept) {
    const shape = JSON.parse(await Bun.file(join(paths.semanticIndex, "meta.json")).text()) as {
      dimensions: number;
      count: number;
      storage?: string;
    };
    const storage = shape.storage === "int8" ? "int8" : "float32";
    if (!(await accept(metadata, { ...shape, storage }))) return null;
  }

  const bm25 = await loadBm25(paths.bm25Index);
  const semantic = await loadSemantic(paths.semanticIndex);
  const chunkData = JSON.parse(await Bun.file(paths.chunks).text()) as Record<string, unknown>[];
  const chunks = chunkData.map(chunkFromDict);
  if (bm25.size !== chunks.length || semantic.size !== chunks.length) {
    throw new Error("Index bundle does not have a BM25 entry and vector for every chunk");
  }
  return { bm25, semantic, chunks, metadata };
}

/** Remove the cached index bundle for a source (same key as `findIndexCachePath`). */
export async function clearCache(path: string): Promise<void> {
  const indexPath = findIndexCachePath(path);
  await rm(indexPath, { recursive: true, force: true });
}
