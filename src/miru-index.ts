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
import { createIndexFromPath } from "./index/create.ts";
import { applyIncrementalFileChanges } from "./index/incremental.ts";
import { persistencePaths, saveIndexBundle } from "./index/persistence.ts";
import type { SemanticIndex } from "./index/semantic-index.ts";
import { hybridSearch, searchSemanticOnly } from "./search.ts";
import type { Chunk, ContentType, SearchResult } from "./types.ts";
import { chunkKey, chunkToDict } from "./types.ts";
import { computeSourceCacheKey, isGitUrl } from "./utils.ts";
import { indexCacheEpoch } from "./version.ts";

export class MiruIndex {
  readonly embeddings: EmbeddingBackend;
  private chunksInternal: Chunk[];
  private bm25Index: BM25Index;
  private semanticIndex: SemanticIndex;
  private loadedFromDiskFlag: boolean;

  readonly embeddingModel: string;
  private readonly root: string | null;
  private readonly content: ContentType[];
  private fileMapping: Map<string, number[]>;
  private languageMapping: Map<string, number[]>;

  get chunks(): Chunk[] {
    return this.chunksInternal;
  }

  get loadedFromDisk(): boolean {
    return this.loadedFromDiskFlag;
  }

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
        root: null,
        content,
      });
      await index.save(findIndexCachePath(cacheKey));
      return index;
    } finally {
      await rm(cloneDir, { recursive: true, force: true });
    }
  }

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

  async saveToDefaultCache(sourcePath: string): Promise<void> {
    if (!this.loadedFromDiskFlag) {
      await this.save(findIndexCachePath(sourcePath));
    }
  }

  async persistToCache(sourcePath: string): Promise<void> {
    await this.save(findIndexCachePath(sourcePath));
  }

  /** Re-chunk and re-embed only the given repo-relative paths; drop their old chunks. */
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

  private getSelector(filterLanguages?: string[], filterPaths?: string[]): number[] | undefined {
    const selector: number[] = [];
    for (const lang of filterLanguages ?? []) {
      selector.push(...(this.languageMapping.get(lang) ?? []));
    }
    for (const fp of filterPaths ?? []) {
      selector.push(...(this.fileMapping.get(fp) ?? []));
    }
    if (selector.length === 0) {
      return undefined;
    }
    return [...new Set(selector)];
  }

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
