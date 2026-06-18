import { join, relative, resolve } from "node:path";
import { chunkSource } from "../chunking/chunking.ts";
import type { EmbeddingBackend } from "../embeddings/openai.ts";
import { tokenize } from "../tokens.ts";
import type { Chunk, ContentType } from "../types.ts";
import { BM25Index } from "./bm25.ts";
import { detectLanguage, getExtensions, getFileStatus, readFileText } from "./files.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { enrichForBm25 } from "./sparse.ts";
import { buildSemanticIndex } from "./vector-storage.ts";
import { vectorAt } from "./vectors.ts";

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

async function chunksForFile(root: string, relativePath: string): Promise<Chunk[]> {
  const rel = normalizeRelativePath(relativePath);
  const absolute = join(root, rel);
  try {
    const status = await getFileStatus(absolute);
    if (status !== "valid") {
      return [];
    }
    const source = await readFileText(absolute);
    const language = detectLanguage(absolute);
    return await chunkSource(source, rel, language);
  } catch {
    return [];
  }
}

function isIndexableRelativePath(relativePath: string, extensions: Set<string>): boolean {
  const rel = normalizeRelativePath(relativePath);
  const name = rel.split("/").pop() ?? rel;
  if (name.toLowerCase() === "dockerfile") {
    return true;
  }
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return extensions.has(ext);
}

/**
 * Replace chunks for the given repo-relative paths only: remove old chunks,
 * embed new ones, rebuild BM25 + semantic indexes from the merged vector set.
 */
export async function applyIncrementalFileChanges(options: {
  root: string;
  content: ContentType[];
  embeddings: EmbeddingBackend;
  chunks: Chunk[];
  semanticIndex: SemanticIndex;
  relativePaths: readonly string[];
}): Promise<{ chunks: Chunk[]; bm25: BM25Index; semantic: SemanticIndex }> {
  const root = resolve(options.root);
  const extensions = new Set(getExtensions(options.content).map((e) => e.toLowerCase()));
  const targets = new Set(
    options.relativePaths
      .map(normalizeRelativePath)
      .filter((p) => p.length > 0 && isIndexableRelativePath(p, extensions)),
  );

  if (targets.size === 0) {
    return {
      chunks: options.chunks,
      bm25: rebuildBm25(options.chunks),
      semantic: options.semanticIndex,
    };
  }

  const keptChunks: Chunk[] = [];
  const keptVectors: Float32Array[] = [];

  for (let i = 0; i < options.chunks.length; i++) {
    const chunk = options.chunks[i];
    if (!chunk) {
      continue;
    }
    const rel = normalizeRelativePath(chunk.file_path);
    if (targets.has(rel)) {
      continue;
    }
    keptChunks.push(chunk);
    keptVectors.push(vectorAt(options.semanticIndex, i));
  }

  const addedChunks: Chunk[] = [];
  for (const rel of targets) {
    addedChunks.push(...(await chunksForFile(root, rel)));
  }

  let addedVectors: Float32Array[] = [];
  if (addedChunks.length > 0) {
    addedVectors = await options.embeddings.embedDocuments(addedChunks.map((c) => c.content));
  }

  const chunks = [...keptChunks, ...addedChunks];
  const vectors = [...keptVectors, ...addedVectors];

  if (chunks.length === 0) {
    throw new Error(`No indexed chunks remain under ${root}.`);
  }

  if (vectors.length !== chunks.length) {
    throw new Error(`Vector count ${vectors.length} does not match chunk count ${chunks.length}.`);
  }

  return {
    chunks,
    bm25: rebuildBm25(chunks),
    semantic: buildSemanticIndex(vectors),
  };
}

function rebuildBm25(chunks: Chunk[]): BM25Index {
  const bm25 = new BM25Index();
  bm25.index(chunks.map((c) => tokenize(enrichForBm25(c))));
  return bm25;
}

/** Map an absolute changed path to a repo-relative path for chunk keys. */
export function relativePathFromRoot(root: string, absoluteOrRelative: string): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, absoluteOrRelative);
  if (candidate.startsWith(`${resolvedRoot}/`) || candidate === resolvedRoot) {
    return normalizeRelativePath(relative(resolvedRoot, candidate));
  }
  return normalizeRelativePath(absoluteOrRelative);
}
