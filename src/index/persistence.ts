import { join } from "node:path";
import { BM25Index } from "./bm25.ts";
import { VectorIndex } from "./dense.ts";
import { QuantizedVectorIndex } from "./quantize.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { resolveSemanticStorage, semanticStorageOf } from "./vector-storage.ts";

export interface PersistencePaths {
  root: string;
  bm25Index: string;
  semanticIndex: string;
  chunks: string;
  metadata: string;
}

export function persistencePaths(root: string): PersistencePaths {
  return {
    root,
    bm25Index: join(root, "bm25_index.json"),
    semanticIndex: join(root, "semantic_index"),
    chunks: join(root, "chunks.json"),
    metadata: join(root, "metadata.json"),
  };
}

export async function pathsExist(paths: PersistencePaths): Promise<string[]> {
  const missing: string[] = [];
  const checks: [string, string][] = [
    ["bm25", paths.bm25Index],
    ["semantic", `${paths.semanticIndex}/meta.json`],
    ["chunks", paths.chunks],
    ["metadata", paths.metadata],
  ];
  for (const [name, p] of checks) {
    if (!(await Bun.file(p).exists())) {
      missing.push(name);
    }
  }
  return missing;
}

export async function saveBm25(index: BM25Index, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(index.toJSON()));
}

export async function loadBm25(path: string): Promise<BM25Index> {
  return BM25Index.fromJSON(JSON.parse(await Bun.file(path).text()));
}

export async function saveSemantic(index: SemanticIndex, path: string): Promise<void> {
  if (index instanceof QuantizedVectorIndex) {
    await index.save(path);
    return;
  }
  if (index instanceof VectorIndex) {
    await index.save(path);
    return;
  }
  throw new Error("Unsupported semantic index type");
}

export async function loadSemantic(path: string): Promise<SemanticIndex> {
  const meta = JSON.parse(await Bun.file(`${path}/meta.json`).text()) as {
    storage?: string;
  };
  if (meta.storage === "int8") {
    return QuantizedVectorIndex.load(path);
  }
  return VectorIndex.load(path);
}

export async function saveIndexBundle(options: {
  paths: PersistencePaths;
  bm25: BM25Index;
  semantic: SemanticIndex;
  chunks: unknown[];
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { paths, bm25, semantic, chunks, metadata } = options;
  await saveBm25(bm25, paths.bm25Index);
  await saveSemantic(semantic, paths.semanticIndex);
  await Bun.write(
    paths.metadata,
    JSON.stringify({
      ...metadata,
      vector_storage: semanticStorageOf(semantic),
    }),
  );
  await Bun.write(paths.chunks, JSON.stringify(chunks));
}

export async function semanticIndexMatchesStorage(path: string): Promise<boolean> {
  const meta = JSON.parse(await Bun.file(`${path}/meta.json`).text()) as {
    storage?: string;
  };
  const stored = meta.storage === "int8" ? "int8" : "float32";
  return stored === resolveSemanticStorage();
}
