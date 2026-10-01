import { isAbsolute, join, relative, resolve } from "node:path";
import { chunkSource } from "../chunking/chunking.ts";
import type { EmbeddingBackend } from "../embeddings/openai.ts";
import type { Chunk, ContentType } from "../types.ts";
import type { BM25Index } from "./bm25.ts";
import { detectLanguage, getExtensions, getFileStatus, readFileText } from "./files.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { buildBm25FromChunks, patchBm25 } from "./sparse.ts";
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

/** Vector for every text: reused from `known`, otherwise embedded once (duplicates share a call). */
async function vectorsByText(
  embeddings: EmbeddingBackend,
  texts: readonly string[],
  known: ReadonlyMap<string, Float32Array>,
): Promise<Map<string, Float32Array>> {
  const result = new Map(known);
  const missing = [...new Set(texts)].filter((text) => !result.has(text));
  if (missing.length === 0) {
    return result;
  }
  const embedded = await embeddings.embedDocuments(missing);
  if (embedded.length !== missing.length) {
    throw new Error(
      `Vector count ${embedded.length} does not match chunk count ${missing.length}.`,
    );
  }
  for (const [i, text] of missing.entries()) {
    result.set(text, embedded[i] as Float32Array);
  }
  return result;
}

/**
 * Replace chunks for the given repo-relative paths only: remove old chunks,
 * embed new ones, rebuild the semantic index from the merged vector set, and update
 * BM25 by dropping the old docs and indexing only the new chunks. Pass `bm25` (the
 * index matching `chunks`) to enable that; without it BM25 is rebuilt from scratch.
 */
export async function applyIncrementalFileChanges(options: {
  root: string;
  content: ContentType[];
  embeddings: EmbeddingBackend;
  chunks: Chunk[];
  semanticIndex: SemanticIndex;
  bm25?: BM25Index;
  relativePaths: readonly string[];
}): Promise<{ chunks: Chunk[]; bm25: BM25Index; semantic: SemanticIndex }> {
  const root = resolve(options.root);
  const extensions = new Set(getExtensions(options.content).map((e) => e.toLowerCase()));
  const targets = new Set(
    options.relativePaths
      .map(normalizeRelativePath)
      .filter((p) => p.length > 0 && isIndexableRelativePath(p, extensions)),
  );

  // BM25 doc i is chunk i; an index of another size can't be patched safely.
  const baseBm25 = options.bm25?.size === options.chunks.length ? options.bm25 : undefined;

  if (targets.size === 0) {
    return {
      chunks: options.chunks,
      bm25: baseBm25 ?? buildBm25FromChunks(options.chunks),
      semantic: options.semanticIndex,
    };
  }

  const keptChunks: Chunk[] = [];
  const keptVectors: Float32Array[] = [];
  const removedDocs = new Set<number>();
  // An embedding is a pure function of chunk text, so a re-chunked file can reuse
  // the vector of any old chunk with byte-identical content (keyed on the exact
  // string, never a hash, so a collision can't leave a stale vector).
  const reusableVectors = new Map<string, Float32Array>();

  for (let i = 0; i < options.chunks.length; i++) {
    const chunk = options.chunks[i];
    if (!chunk) {
      continue;
    }
    const rel = normalizeRelativePath(chunk.file_path);
    if (targets.has(rel)) {
      removedDocs.add(i);
      if (!reusableVectors.has(chunk.content)) {
        reusableVectors.set(chunk.content, vectorAt(options.semanticIndex, i));
      }
      continue;
    }
    keptChunks.push(chunk);
    keptVectors.push(vectorAt(options.semanticIndex, i));
  }

  const addedChunks: Chunk[] = [];
  for (const rel of targets) {
    addedChunks.push(...(await chunksForFile(root, rel)));
  }

  const vectorFor = await vectorsByText(
    options.embeddings,
    addedChunks.map((c) => c.content),
    reusableVectors,
  );
  const addedVectors = addedChunks.map((c) => vectorFor.get(c.content) as Float32Array);

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
    bm25: baseBm25 ? patchBm25(baseBm25, removedDocs, addedChunks) : buildBm25FromChunks(chunks),
    semantic: buildSemanticIndex(vectors),
  };
}

/** Map an absolute changed path to a repo-relative path for chunk keys. */
export function relativePathFromRoot(root: string, absoluteOrRelative: string): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, absoluteOrRelative);
  const rel = normalizeRelativePath(relative(resolvedRoot, candidate));
  if (rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))) {
    return rel;
  }
  return normalizeRelativePath(absoluteOrRelative);
}
