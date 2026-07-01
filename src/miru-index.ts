import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { findIndexCachePath, getValidatedCache, loadCachedIndex } from "./cache.ts";
import {
  type EmbeddingBackend,
  getEmbeddingBackend,
  resolveEmbeddingDimensions,
  resolveEmbeddingModel,
} from "./embeddings/openai.ts";
import { cloneGitRepository } from "./git.ts";
import type { BM25Index } from "./index/bm25.ts";
import { buildChunkSelector } from "./index/chunk-selector.ts";
import { createIndexFromPath } from "./index/create.ts";
import { applyIncrementalFileChanges } from "./index/incremental.ts";
import { persistencePaths, saveIndexBundle } from "./index/persistence.ts";
import type { SemanticIndex } from "./index/semantic-index.ts";
import { hybridSearch, searchSemanticOnly } from "./search.ts";
import type { Chunk, ContentType, SearchResult } from "./types.ts";
import { chunkKey, chunkToDict } from "./types.ts";
import { computeSourceCacheKey, isGitUrl } from "./utils.ts";
import { indexCacheEpoch } from "./version.ts";

/**
 * In-memory search index over a codebase: BM25 keyword scores plus semantic
 * embeddings, with optional disk cache for reuse across runs.
 *
 * Construct via `fromPath`, `fromGit`, or `fromSource`; load a saved bundle
 * with `loadFromDisk`. Search combines both signals; `findRelated` is
 * semantic-only similarity from an existing chunk or hit.
 *
 * Lifecycle:
 * - **Build** — parse files, chunk, embed, score with BM25
 * - **Cache** — `save` writes a bundle keyed by source path or git URL + ref
 * - **Query** — `search` blends BM25 and vectors; filters use prebuilt mappings
 * - **Update** — `applyFileChanges` re-indexes only touched paths (local roots)
 */
export class MiruIndex {
  /** OpenAI (or configured) client used for query embeddings and reranking. */
  readonly embeddings: EmbeddingBackend;

  /** Flat list of all chunks; index position is the stable chunk id. */
  private chunksInternal: Chunk[];

  /** Inverted index for lexical (BM25) retrieval. */
  private bm25Index: BM25Index;

  /** Vector store for semantic nearest-neighbor search. */
  private semanticIndex: SemanticIndex;

  /**
   * True when hydrated from disk via `loadFromDisk`.
   * Affects `saveToCache`, which skips re-saving already-cached indexes unless forced.
   */
  private loadedFromDiskFlag: boolean;

  /** Model id stored in cache metadata and used for new embeddings. */
  readonly embeddingModel: string;

  /**
   * Absolute path to the indexed tree on disk, or `null` for git-only indexes
   * (clone is deleted after indexing; incremental updates need a local root).
   */
  private readonly root: string | null;

  /** Content kinds indexed at build time (e.g. `code`, `markdown`). */
  private readonly content: ContentType[];

  /** Repo-relative file path → chunk indices in `chunksInternal`. */
  private fileMapping: Map<string, number[]>;

  /** Language tag → chunk indices, for `filterLanguages` in search. */
  private languageMapping: Map<string, number[]>;

  /** Read-only view of indexed chunks. */
  get chunks(): Chunk[] {
    return this.chunksInternal;
  }

  /** Whether this instance was loaded from a cache bundle rather than freshly built. */
  get loadedFromDisk(): boolean {
    return this.loadedFromDiskFlag;
  }

  /**
   * Prefer static factories (`fromPath`, `fromGit`, `loadFromDisk`) over calling
   * directly; the constructor is public for tests and advanced composition.
   */
  constructor(options: {
    embeddings: EmbeddingBackend;
    bm25Index: BM25Index;
    semanticIndex: SemanticIndex;
    chunks: Chunk[];
    embeddingModel: string;
    root?: string | null;
    content?: ContentType[];
    loadedFromDisk?: boolean;
  }) {
    this.embeddings = options.embeddings;
    this.bm25Index = options.bm25Index;
    this.semanticIndex = options.semanticIndex;
    this.chunksInternal = options.chunks;
    this.embeddingModel = options.embeddingModel;
    this.root = options.root ?? null;
    this.content = options.content ?? ["code"];
    this.loadedFromDiskFlag = options.loadedFromDisk ?? false;
    this.fileMapping = new Map();
    this.languageMapping = new Map();
    this.rebuildMappings();
  }

  /**
   * Rebuild file/language → chunk-index maps after chunks change.
   * Called from the constructor and after incremental updates.
   */
  private rebuildMappings(): void {
    this.fileMapping = new Map();
    this.languageMapping = new Map();
    for (let i = 0; i < this.chunksInternal.length; i++) {
      const chunk = this.chunksInternal[i];
      if (!chunk) {
        continue;
      }
      const fp = chunk.file_path;
      if (!this.fileMapping.has(fp)) {
        this.fileMapping.set(fp, []);
      }
      this.fileMapping.get(fp)?.push(i);
      if (chunk.language) {
        if (!this.languageMapping.has(chunk.language)) {
          this.languageMapping.set(chunk.language, []);
        }
        this.languageMapping.get(chunk.language)?.push(i);
      }
    }
  }

  /**
   * Clone a remote repo, index it, persist to cache, and return the in-memory index.
   *
   * Cache key is derived from URL + ref. On hit, skips clone and embedding work.
   * The temporary clone directory is always removed in `finally`.
   */
  static async fromGit(
    url: string,
    content: ContentType[] = ["code"],
    embeddingModel?: string,
    ref?: string | null,
  ): Promise<MiruIndex> {
    const cacheKey = computeSourceCacheKey(url, ref);
    const model = embeddingModel ?? resolveEmbeddingModel();
    const cached = await getValidatedCache(cacheKey, model, content);
    if (cached) {
      return MiruIndex.loadFromDisk(cached, model);
    }

    const cloneDir = await cloneGitRepository(url, ref);
    try {
      const embeddings = getEmbeddingBackend(model);
      const { bm25, semantic, chunks } = await createIndexFromPath(
        cloneDir,
        embeddings,
        content,
        cloneDir,
      );
      const index = new MiruIndex({
        embeddings,
        bm25Index: bm25,
        semanticIndex: semantic,
        chunks,
        embeddingModel: model,
        // No durable local root — clone is deleted; incremental updates unavailable.
        root: null,
        content,
      });
      await index.save(findIndexCachePath(cacheKey));
      return index;
    } finally {
      await rm(cloneDir, { recursive: true, force: true });
    }
  }

  /** Resolve a local path or git URL and delegate to `fromPath` or `fromGit`. */
  static async fromSource(
    source: string,
    content: ContentType[] = ["code"],
    embeddingModel?: string,
    ref?: string | null,
  ): Promise<MiruIndex> {
    if (isGitUrl(source)) {
      return MiruIndex.fromGit(source, content, embeddingModel, ref);
    }
    return MiruIndex.fromPath(source, content, embeddingModel);
  }

  /**
   * Index a directory on disk, reusing a validated cache hit when available.
   *
   * `root` is set to the resolved path so `applyFileChanges` can re-chunk files
   * later. Unlike `fromGit`, this does not auto-save to cache; callers use
   * `saveToCache` when they want persistence.
   */
  static async fromPath(
    path: string,
    content: ContentType[] = ["code"],
    embeddingModel?: string,
  ): Promise<MiruIndex> {
    const resolved = resolve(path);
    try {
      const st = await Bun.file(resolved).stat();
      if (!st.isDirectory()) {
        throw new Error(`Path is not a directory: ${path}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Path is not a directory")) {
        throw err;
      }
      throw new Error(`Path does not exist: ${path}`);
    }

    const model = embeddingModel ?? resolveEmbeddingModel();
    const cached = await getValidatedCache(resolved, model, content);
    if (cached) {
      return MiruIndex.loadFromDisk(cached, model);
    }

    const embeddings = getEmbeddingBackend(model);
    const { bm25, semantic, chunks } = await createIndexFromPath(
      resolved,
      embeddings,
      content,
      resolved,
    );

    return new MiruIndex({
      embeddings,
      bm25Index: bm25,
      semanticIndex: semantic,
      chunks,
      embeddingModel: model,
      root: resolved,
      content,
    });
  }

  /**
   * Hydrate BM25, semantic vectors, and chunks from a saved index bundle.
   *
   * Validates embedding model compatibility via cache metadata. Sets
   * `loadedFromDisk` so callers can avoid redundant cache writes.
   */
  static async loadFromDisk(path: string, embeddingModel?: string): Promise<MiruIndex> {
    const model = embeddingModel ?? resolveEmbeddingModel();
    const { bm25, semantic, chunks, metadata } = await loadCachedIndex(path);
    const content = (metadata.content_type as ContentType[]) ?? ["code"];
    const root = metadata.root_path ? String(metadata.root_path) : null;

    return new MiruIndex({
      embeddings: getEmbeddingBackend(model),
      bm25Index: bm25,
      semanticIndex: semantic,
      chunks,
      embeddingModel: model,
      root,
      content,
      loadedFromDisk: true,
    });
  }

  /**
   * Write BM25, semantic vectors, chunk metadata, and index metadata to `path`.
   *
   * Metadata includes `index_epoch` for invalidation when Miru's on-disk format
   * changes, plus embedding model/dimensions for cache validation on reload.
   */
  async save(path: string): Promise<void> {
    const paths = persistencePaths(path);
    await mkdir(paths.root, { recursive: true });
    await saveIndexBundle({
      paths,
      bm25: this.bm25Index,
      semantic: this.semanticIndex,
      chunks: this.chunks.map(chunkToDict),
      metadata: {
        index_epoch: indexCacheEpoch(),
        root_path: this.root,
        time: Date.now() / 1000,
        embedding_model: this.embeddingModel,
        embedding_dimensions:
          this.embeddings.dimensions || resolveEmbeddingDimensions(this.embeddingModel),
        embedding_provider: "openai",
        content_type: this.content,
        file_paths: [...this.fileMapping.keys()].sort(),
      },
    });
  }

  /**
   * Persist to the default cache location for `sourcePath`.
   *
   * By default this is a no-op for unchanged indexes loaded from disk, avoiding
   * redundant cache writes. Pass `force: true` after mutating a cached index.
   */
  async saveToCache(sourcePath: string, options: { force?: boolean } = {}): Promise<void> {
    if (!this.loadedFromDiskFlag || options.force) {
      await this.save(findIndexCachePath(sourcePath));
    }
  }

  /**
   * Re-chunk and re-embed only the given repo-relative paths; drop their old chunks.
   *
   * Requires `root` (local `fromPath` indexes only). Updates BM25, semantic
   * index, and mappings in place; clears `loadedFromDisk` since data changed.
   */
  async applyFileChanges(relativePaths: readonly string[]): Promise<void> {
    if (!this.root) {
      throw new Error("Incremental update requires a local index with root_path set.");
    }
    if (relativePaths.length === 0) {
      return;
    }

    const updated = await applyIncrementalFileChanges({
      root: this.root,
      content: this.content,
      embeddings: this.embeddings,
      chunks: this.chunksInternal,
      semanticIndex: this.semanticIndex,
      relativePaths,
    });

    this.chunksInternal = updated.chunks;
    this.bm25Index = updated.bm25;
    this.semanticIndex = updated.semantic;
    this.loadedFromDiskFlag = false;
    this.rebuildMappings();
  }

  private getSelector(
    filterLanguages?: string[],
    filterPaths?: string[],
  ): readonly number[] | undefined {
    return buildChunkSelector(
      {
        fileMapping: this.fileMapping,
        languageMapping: this.languageMapping,
      },
      filterLanguages,
      filterPaths,
    );
  }

  /**
   * Hybrid BM25 + semantic search over indexed chunks.
   *
   * `alpha` blends keyword vs vector scores (default depends on content type).
   * `filterLanguages` / `filterPaths` restrict candidates before ranking.
   * `rerank` defaults to on for code indexes (cross-encoder style reranking).
   */
  async search(options: {
    query: string;
    topK?: number;
    alpha?: number | null;
    filterLanguages?: string[];
    filterPaths?: string[];
    rerank?: boolean;
  }): Promise<SearchResult[]> {
    const { query, topK = 10, alpha, filterLanguages, filterPaths, rerank } = options;

    if (!this.chunks.length || !query.trim()) {
      return [];
    }

    const resolvedRerank = rerank ?? this.content.includes("code");

    return hybridSearch({
      query,
      embeddings: this.embeddings,
      semanticIndex: this.semanticIndex,
      bm25Index: this.bm25Index,
      chunks: this.chunks,
      topK,
      alpha,
      selector: this.getSelector(filterLanguages, filterPaths),
      rerank: resolvedRerank,
    });
  }

  /**
   * Semantic neighbors of a chunk or search hit, excluding the source itself.
   *
   * Uses the chunk's text as the query embedding. When the source has a
   * language, search is scoped to same-language chunks. Requests `topK + 1`
   * hits so filtering out the source still yields `topK` results.
   */
  async findRelated(source: Chunk | SearchResult, topK = 5): Promise<SearchResult[]> {
    const target = "chunk" in source ? source.chunk : source;
    const selector = target.language ? this.getSelector([target.language]) : undefined;

    const results = await searchSemanticOnly({
      query: target.content,
      embeddings: this.embeddings,
      semanticIndex: this.semanticIndex,
      chunks: this.chunks,
      topK: topK + 1,
      selector,
    });

    return results.filter((r) => chunkKey(r.chunk) !== chunkKey(target)).slice(0, topK);
  }
}
