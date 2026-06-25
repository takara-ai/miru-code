/**
 * Public library entry point for programmatic Miru usage.
 *
 * Import from here rather than deep paths so internal module layout can change
 * without breaking consumers. Typical flow:
 *
 * 1. `MiruIndex.fromPath` / `fromGit` / `fromSource` — build or load an index
 * 2. `index.search` — hybrid keyword + semantic retrieval
 * 3. `findIndexCachePath` / `resolveCacheFolder` — inspect or manage on-disk cache
 */

/** Remove cached index bundles (all or for one source key). */
export { clearCache, findIndexCachePath, resolveCacheFolder } from "./cache.ts";

/** Main index type: chunking, BM25, embeddings, search, and persistence. */
export { MiruIndex } from "./miru-index.ts";

export type {
  /** A searchable text span from a source file (path, line range, content). */
  Chunk,
  /** What to index: source code, markdown docs, or both. */
  ContentType,
  /** Ranked hit returned by `search` or `findRelated`. */
  SearchResult,
} from "./types.ts";
