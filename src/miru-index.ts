import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { findIndexCachePath, loadCachedIndex, loadValidatedCache } from "./cache.ts";
import {
  type EmbeddingBackend,
  getEmbeddingBackend,
  resolveEmbeddingDimensions,
  resolveEmbeddingModel,
} from "./embeddings/openai.ts";
import { cloneGitRepository } from "./git.ts";
import type { BM25Index } from "./index/bm25.ts";
import { withIndexCacheLock } from "./index/cache-lock.ts";
import { buildChunkSelector } from "./index/chunk-selector.ts";
import { createIndexFromPath } from "./index/create.ts";
import {
  applyIncrementalFileChanges,
  findChangedFiles,
  normalizeRelativePath,
} from "./index/incremental.ts";
import type { SemanticIndex } from "./index/semantic-index.ts";
import { cleanIndexFiles, saveIndexSnapshot } from "./index/snapshot.ts";
import {
  filterChunksByGlob,
  type LiteralLocateOptions,
  type LiteralLocateResult,
  locateLiteral,
} from "./literal.ts";
import { hybridSearch, searchSemanticOnly } from "./search.ts";
import type { Chunk, ContentType, SearchResult } from "./types.ts";
import { chunkKey, defaultContentTypes } from "./types.ts";
import { computeSourceCacheKey, isGitUrl } from "./utils.ts";
import { indexCacheEpoch } from "./version.ts";

interface FactoryDependencies {
  loadValidatedCache: typeof loadValidatedCache;
  resolveEmbeddingModel: typeof resolveEmbeddingModel;
  getEmbeddingBackend: (model: string) => EmbeddingBackend;
  createIndexFromPath: typeof createIndexFromPath;
  cloneGitRepository: typeof cloneGitRepository;
  findIndexCachePath: typeof findIndexCachePath;
  loadCachedIndex: typeof loadCachedIndex;
  saveBuiltIndex?: (index: MiruIndex, path: string) => Promise<void>;
}

function factoryDependencies(overrides: Partial<FactoryDependencies> = {}): FactoryDependencies {
  return {
    loadValidatedCache,
    resolveEmbeddingModel,
    getEmbeddingBackend,
    createIndexFromPath,
    cloneGitRepository,
    findIndexCachePath,
    loadCachedIndex,
    ...overrides,
  };
}

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
  private readonly _root: string | null;

  /** Content kinds indexed at build time (e.g. `code`, `markdown`). */
  private readonly content: ContentType[];

  /** Default code ranking is disabled for prose-only indexes. */
  get supportsCodeRanking(): boolean {
    return this.content.includes("code");
  }

  /** Repo-relative file path → chunk indices in `chunksInternal`. */
  private fileMapping: Map<string, number[]>;

  /** Language tag → chunk indices, for `filterLanguages` in search. */
  private languageMapping: Map<string, number[]>;

  /** Stored file mtimes (file path → mtime_ms) for cache freshness checking. */
  private storedFileMtimes: Map<string, number>;

  /** Read-only view of indexed chunks. */
  get chunks(): Chunk[] {
    return this.chunksInternal;
  }

  /** Whether this instance was loaded from a cache bundle rather than freshly built. */
  get loadedFromDisk(): boolean {
    return this.loadedFromDiskFlag;
  }

  /** Get stored file mtimes for cache validation. */
  getStoredFileMtimes(): Map<string, number> {
    return this.storedFileMtimes;
  }

  /** Get the root path for local indexes (null for git indexes). */
  get root(): string | null {
    return this._root;
  }

  /** Content kinds indexed at build time, for re-walking the tree during freshness checks. */
  get contentTypes(): ContentType[] {
    return this.content;
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
    storedFileMtimes?: Record<string, number>;
  }) {
    this.embeddings = options.embeddings;
    this.bm25Index = options.bm25Index;
    this.semanticIndex = options.semanticIndex;
    this.chunksInternal = options.chunks;
    this.embeddingModel = options.embeddingModel;
    this._root = options.root ?? null;
    this.content = options.content ?? defaultContentTypes();
    this.loadedFromDiskFlag = options.loadedFromDisk ?? false;
    this.storedFileMtimes = new Map(Object.entries(options.storedFileMtimes ?? {}));
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
    content: ContentType[] = defaultContentTypes(),
    embeddingModel?: string,
    ref?: string | null,
    dependencies?: Partial<FactoryDependencies>,
  ): Promise<MiruIndex> {
    const deps = factoryDependencies(dependencies);
    const cacheKey = computeSourceCacheKey(url, ref);
    const model = embeddingModel ?? deps.resolveEmbeddingModel();
    return MiruIndex.loadOrBuildCached(cacheKey, model, content, deps, async () => {
      const cloneDir = await deps.cloneGitRepository(url, ref);
      try {
        return await MiruIndex.buildFromPath(cloneDir, model, content, deps, null);
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    });
  }

  /** Resolve a local path or git URL and delegate to `fromPath` or `fromGit`. */
  static async fromSource(
    source: string,
    content: ContentType[] = defaultContentTypes(),
    embeddingModel?: string,
    ref?: string | null,
    dependencies?: Partial<FactoryDependencies>,
  ): Promise<MiruIndex> {
    if (isGitUrl(source)) {
      return MiruIndex.fromGit(source, content, embeddingModel, ref, dependencies);
    }
    return MiruIndex.fromPath(source, content, embeddingModel, dependencies);
  }

  /** CLI and MCP entry point that persists local builds before releasing the cache lock. */
  static async fromCachedSource(
    source: string,
    content: ContentType[] = defaultContentTypes(),
    embeddingModel?: string,
    ref?: string | null,
    dependencies?: Partial<FactoryDependencies>,
    localRefresh: "immediate" | "watch" = "immediate",
  ): Promise<MiruIndex> {
    if (isGitUrl(source)) {
      return MiruIndex.fromGit(source, content, embeddingModel, ref, dependencies);
    }
    const deps = factoryDependencies(dependencies);
    const resolved = await MiruIndex.resolveLocalSource(source);
    const model = embeddingModel ?? deps.resolveEmbeddingModel();
    return MiruIndex.loadOrBuildCached(
      resolved,
      model,
      content,
      deps,
      () => MiruIndex.buildFromPath(resolved, model, content, deps, resolved),
      localRefresh,
    );
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
    content: ContentType[] = defaultContentTypes(),
    embeddingModel?: string,
    dependencies?: Partial<FactoryDependencies>,
  ): Promise<MiruIndex> {
    const deps = factoryDependencies(dependencies);
    const resolved = await MiruIndex.resolveLocalSource(path);
    const model = embeddingModel ?? deps.resolveEmbeddingModel();
    return (
      (await MiruIndex.loadSourceCache(resolved, model, content, deps)) ??
      MiruIndex.buildFromPath(resolved, model, content, deps, resolved)
    );
  }

  private static async resolveLocalSource(path: string): Promise<string> {
    const resolved = resolve(path);
    let stat: Awaited<ReturnType<ReturnType<typeof Bun.file>["stat"]>>;
    try {
      stat = await Bun.file(resolved).stat();
    } catch {
      throw new Error(`Path does not exist: ${path}`);
    }
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${path}`);
    return resolved;
  }

  private static async loadOrBuildCached(
    source: string,
    model: string,
    content: ContentType[],
    deps: FactoryDependencies,
    build: () => Promise<MiruIndex>,
    localRefresh?: "immediate" | "watch",
  ): Promise<MiruIndex> {
    const read = () => MiruIndex.loadSourceCache(source, model, content, deps, !!localRefresh);
    const changedFiles = (index: MiruIndex) =>
      localRefresh === "immediate" && index.root
        ? findChangedFiles(index.root, index.contentTypes, index.getStoredFileMtimes())
        : [];

    const cached = await read();
    if (cached && (await changedFiles(cached)).length === 0) return cached;

    const path = deps.findIndexCachePath(source);
    return withIndexCacheLock(path, async () => {
      // A foreground refresh or background checkpoint may have won the lock.
      const reopened = await read();
      let index: MiruIndex;
      if (reopened) {
        const changed = await changedFiles(reopened);
        if (changed.length === 0) return reopened;
        await reopened.applyFileChanges(changed);
        index = reopened;
      } else {
        await cleanIndexFiles(path, false).catch(() => {});
        index = await build();
      }
      if (deps.saveBuiltIndex) await deps.saveBuiltIndex(index, path);
      else await index.saveSnapshot(path, true);
      return index;
    });
  }

  private static async buildFromPath(
    path: string,
    model: string,
    content: ContentType[],
    deps: FactoryDependencies,
    root: string | null,
  ): Promise<MiruIndex> {
    const embeddings = deps.getEmbeddingBackend(model);
    const { bm25, semantic, chunks, fileMtimes } = await deps.createIndexFromPath(
      path,
      embeddings,
      content,
      path,
    );

    return new MiruIndex({
      embeddings,
      bm25Index: bm25,
      semanticIndex: semantic,
      chunks,
      embeddingModel: model,
      root,
      content,
      storedFileMtimes: root ? fileMtimes : undefined,
    });
  }

  /**
   * Hydrate BM25, semantic vectors, and chunks from a saved index bundle.
   *
   * Validates embedding model compatibility via cache metadata. Sets
   * `loadedFromDisk` so callers can avoid redundant cache writes.
   */
  static async loadFromDisk(
    path: string,
    embeddingModel?: string,
    dependencies?: Partial<FactoryDependencies>,
  ): Promise<MiruIndex> {
    const deps = factoryDependencies(dependencies);
    const model = embeddingModel ?? deps.resolveEmbeddingModel();
    const bundle = await deps.loadCachedIndex(path);
    return MiruIndex.hydrate(bundle, model, deps);
  }

  private static async loadSourceCache(
    source: string,
    model: string,
    content: ContentType[],
    deps: FactoryDependencies,
    reconcileMissingFiles = false,
  ): Promise<MiruIndex | null> {
    const bundle = await deps.loadValidatedCache(source, model, content, reconcileMissingFiles);
    return bundle ? MiruIndex.hydrate(bundle, model, deps) : null;
  }

  private static hydrate(
    { bm25, semantic, chunks, metadata }: Awaited<ReturnType<typeof loadCachedIndex>>,
    model: string,
    deps: FactoryDependencies,
  ): MiruIndex {
    const content = (metadata.content_type as ContentType[]) ?? defaultContentTypes();
    const root = metadata.root_path ? String(metadata.root_path) : null;
    const storedFileMtimes = { ...(metadata.file_mtimes as Record<string, number> | undefined) };
    if (Array.isArray(metadata.file_paths)) {
      for (const path of metadata.file_paths) {
        if (typeof path === "string" && !Object.hasOwn(storedFileMtimes, path)) {
          Object.defineProperty(storedFileMtimes, path, { value: 0, enumerable: true });
        }
      }
    }

    return new MiruIndex({
      embeddings: deps.getEmbeddingBackend(model),
      bm25Index: bm25,
      semanticIndex: semantic,
      chunks,
      embeddingModel: model,
      root,
      content,
      loadedFromDisk: true,
      storedFileMtimes,
    });
  }

  /**
   * Write BM25, semantic vectors, chunk metadata, and index metadata to `path`.
   *
   * Metadata includes `index_epoch` for invalidation when Miru's on-disk format
   * changes, plus embedding model/dimensions for cache validation on reload.
   */
  async save(path: string, options: { managedCache?: boolean } = {}): Promise<void> {
    await withIndexCacheLock(path, () => this.saveSnapshot(path, options.managedCache ?? false));
  }

  private async saveSnapshot(path: string, managedCache: boolean): Promise<void> {
    const { bm25Index: bm25, semanticIndex: semantic, chunksInternal: chunks } = this;
    const filePaths = [...this.fileMapping.keys()].sort();

    const fileMtimes: Record<string, number> = {};
    const root = this._root;
    if (root) {
      for (const filePath of filePaths) {
        fileMtimes[filePath] =
          this.storedFileMtimes.get(filePath) ?? (await MiruIndex.readFileMtime(root, filePath));
      }
    }

    await cleanIndexFiles(path, false).catch(() => {});
    await saveIndexSnapshot(path, {
      bm25,
      semantic,
      chunks,
      metadata: {
        index_epoch: indexCacheEpoch(),
        root_path: this._root,
        time: Date.now() / 1000,
        embedding_model: this.embeddingModel,
        embedding_dimensions:
          this.embeddings.dimensions || resolveEmbeddingDimensions(this.embeddingModel),
        embedding_provider: "openai",
        content_type: this.content,
        file_paths: filePaths,
        file_mtimes: fileMtimes,
      },
    });
    if (managedCache) await cleanIndexFiles(path, true).catch(() => {});
    if (this.chunksInternal === chunks) {
      this.storedFileMtimes = new Map(Object.entries(fileMtimes));
    }
  }

  private static async readFileMtime(root: string, path: string): Promise<number> {
    try {
      return Math.floor((await stat(resolve(root, path))).mtimeMs);
    } catch {
      return 0;
    }
  }

  /**
   * Persist to the default cache location for `sourcePath`.
   *
   * By default this is a no-op for unchanged indexes loaded from disk, avoiding
   * redundant cache writes. Pass `force: true` after mutating a cached index.
   */
  async saveToCache(sourcePath: string, options: { force?: boolean } = {}): Promise<void> {
    if (!this.loadedFromDiskFlag || options.force) {
      await this.save(findIndexCachePath(sourcePath), { managedCache: true });
    }
  }

  /**
   * Re-chunk and re-embed only the given repo-relative paths; drop their old chunks.
   *
   * Requires `root` (local `fromPath` indexes only). Updates BM25, semantic
   * index, and mappings in place; clears `loadedFromDisk` since data changed.
   */
  async applyFileChanges(relativePaths: readonly string[]): Promise<void> {
    if (!this._root) {
      throw new Error("Incremental update requires a local index with root_path set.");
    }
    if (relativePaths.length === 0) {
      return;
    }

    // Capture mtimes before reading source so a later edit is still visible on restart.
    const root = this._root;
    const mtimes = await Promise.all(
      [...new Set(relativePaths.map(normalizeRelativePath))].map(
        async (path) => [path, await MiruIndex.readFileMtime(root, path)] as const,
      ),
    );
    const updated = await applyIncrementalFileChanges({
      root,
      content: this.content,
      embeddings: this.embeddings,
      chunks: this.chunksInternal,
      semanticIndex: this.semanticIndex,
      bm25: this.bm25Index,
      relativePaths,
    });

    this.chunksInternal = updated.chunks;
    this.bm25Index = updated.bm25;
    this.semanticIndex = updated.semantic;
    this.loadedFromDiskFlag = false;
    this.rebuildMappings();
    for (const [path, mtime] of mtimes) {
      if (this.fileMapping.has(path)) this.storedFileMtimes.set(path, mtime);
      else this.storedFileMtimes.delete(path);
    }
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

  private getPathSelector(include?: string[], exclude?: string[]): readonly number[] | undefined {
    if (!include?.length && !exclude?.length) {
      return undefined;
    }
    const included = new Set(filterChunksByGlob(this.chunks, include, exclude).map(chunkKey));
    return this.chunks.flatMap((chunk, index) => (included.has(chunkKey(chunk)) ? [index] : []));
  }

  /**
   * Hybrid BM25 + semantic search over indexed chunks.
   *
   * `alpha` blends keyword vs vector scores (default depends on content type).
   * `include` / `exclude` glob patterns restrict candidate files before ranking.
   * `rerank` defaults to on for code indexes (cross-encoder style reranking).
   */
  async search(options: {
    query: string;
    /** Optional precomputed embedding for high-throughput callers. */
    queryVector?: Float32Array;
    topK?: number;
    alpha?: number | null;
    filterLanguages?: string[];
    filterPaths?: string[];
    include?: string[];
    exclude?: string[];
    rerank?: boolean;
  }): Promise<SearchResult[]> {
    const {
      query,
      queryVector,
      topK = 10,
      alpha,
      filterLanguages,
      filterPaths,
      include,
      exclude,
      rerank,
    } = options;

    if (!this.chunks.length || !query.trim()) {
      return [];
    }

    const resolvedRerank = rerank ?? this.content.includes("code");
    const selector = this.getSelector(filterLanguages, filterPaths);
    const pathSelector = this.getPathSelector(include, exclude);
    let effectiveSelector = pathSelector ?? selector;
    if (selector && pathSelector) {
      const allowedIndices = new Set(selector);
      effectiveSelector = pathSelector.filter((index) => allowedIndices.has(index));
    }

    return hybridSearch({
      query,
      queryVector,
      embeddings: this.embeddings,
      semanticIndex: this.semanticIndex,
      bm25Index: this.bm25Index,
      chunks: this.chunks,
      topK,
      alpha,
      selector: effectiveSelector,
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

  /**
   * Exact substring location over indexed chunks (no disk re-walk).
   * Prefer for known literals; use `search` for meaning-based questions.
   */
  locateLiteral(
    literal: string | readonly string[],
    options?: LiteralLocateOptions,
  ): LiteralLocateResult {
    return locateLiteral(this.chunksInternal, literal, options);
  }
}
