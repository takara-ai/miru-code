import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveEmbeddingDimensions, resolveEmbeddingModel } from "./embeddings/openai.ts";
import {
  loadBm25,
  loadSemantic,
  pathsExist,
  persistencePaths,
  semanticIndexMatchesStorage,
} from "./index/persistence.ts";
import { resolveSemanticStorage, semanticStorageFromMetadata } from "./index/vector-storage.ts";
import type { Chunk, ContentType } from "./types.ts";
import { chunkFromDict } from "./types.ts";
import { computeSourceCacheKey } from "./utils.ts";
import { indexCacheEpoch } from "./version.ts";

export function resolveCacheFolder(): string {
  const override = process.env.MIRU_CACHE_HOME?.trim();
  if (override) {
    return override;
  }
  const name = "miru";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let base: string;
  if (process.platform === "win32") {
    base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(home, "AppData", "Local");
    base = join(base, name, "Cache");
  } else if (process.platform === "darwin") {
    base = join(home, "Library", "Caches", name);
  } else {
    base = process.env.XDG_CACHE_HOME
      ? join(process.env.XDG_CACHE_HOME, name)
      : join(home, ".cache", name);
  }
  return base;
}

export function findIndexCachePath(path: string, ref?: string | null): string {
  const normalized = computeSourceCacheKey(path, ref);
  const subdir = createHash("sha256").update(normalized, "utf-8").digest("hex");
  return join(resolveCacheFolder(), subdir, "index");
}

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

export async function getValidatedCache(
  path: string,
  embeddingModel: string | undefined,
  content: ContentType[],
): Promise<string | null> {
  const indexPath = findIndexCachePath(path);
  const paths = persistencePaths(indexPath);
  const missing = await pathsExist(paths);
  if (missing.length > 0) {
    return null;
  }

  const model = embeddingModel ?? resolveEmbeddingModel();
  const metadata = JSON.parse(await Bun.file(paths.metadata).text()) as Record<string, unknown>;
  if (!metadataMatches(metadata, model, content)) {
    if (metadata.index_epoch !== indexCacheEpoch()) {
      await rm(indexPath, { recursive: true, force: true });
    }
    return null;
  }

  const semanticMeta = JSON.parse(await Bun.file(`${paths.semanticIndex}/meta.json`).text()) as {
    dimensions: number;
  };
  const expectedDims = resolveEmbeddingDimensions(model);
  if (expectedDims != null && semanticMeta.dimensions !== expectedDims) {
    return null;
  }
  if (!(await semanticIndexMatchesStorage(paths.semanticIndex))) {
    return null;
  }

  const rootPath = metadata.root_path as string | null;
  if (rootPath) {
    const filePaths = metadata.file_paths as string[];
    try {
      await Bun.file(rootPath).stat();
      for (const rel of filePaths) {
        try {
          await Bun.file(join(rootPath, rel)).stat();
        } catch {
          return null;
        }
      }
    } catch {
      return null;
    }
  }

  return indexPath;
}

export async function loadCachedIndex(indexPath: string): Promise<{
  bm25: Awaited<ReturnType<typeof loadBm25>>;
  semantic: Awaited<ReturnType<typeof loadSemantic>>;
  chunks: Chunk[];
  metadata: Record<string, unknown>;
}> {
  const paths = persistencePaths(indexPath);
  const bm25 = await loadBm25(paths.bm25Index);
  const semantic = await loadSemantic(paths.semanticIndex);
  const chunkData = JSON.parse(await Bun.file(paths.chunks).text()) as Record<string, unknown>[];
  const chunks = chunkData.map(chunkFromDict);
  const metadata = JSON.parse(await Bun.file(paths.metadata).text()) as Record<string, unknown>;
  return { bm25, semantic, chunks, metadata };
}

export async function clearCache(path: string): Promise<void> {
  const indexPath = findIndexCachePath(path);
  await rm(indexPath, { recursive: true, force: true });
}
