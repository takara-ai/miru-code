/**
 * Contract for the shared, content-addressed, mmapped embedding store.
 *
 * Vectors are keyed by SHA-256 of the exact chunk text, scoped per
 * (embedding model, dimensions). The store only holds int8-quantized rows
 * (the production format); `MIRU_FLOAT_VECTORS=1` bypasses it entirely.
 *
 * On disk, under `<cacheRoot>/embeddings/<scopeDir>/`, every segment is
 * immutable (written to a temp file, then renamed; never modified or truncated):
 *   seg-<id>.hashes.bin  sorted fixed-width 32-byte SHA-256 keys
 *   seg-<id>.codes.bin   int8 rows, row-major, `dimensions` bytes per row,
 *                        in the same order as the hashes
 *   seg-<id>.scales.bin  float32, one per row (own file so the mapping is 4-byte aligned)
 */

export const HASH_BYTES = 32;

export interface StoreScope {
  model: string;
  dimensions: number;
}

/** Reference to a row. `seg` is local to one `EmbeddingStore` handle; never persist it. */
export interface RowRef {
  seg: number;
  row: number;
}

export interface StoreEntry {
  /** `hashText(chunk.content)` */
  hash: Uint8Array;
  /** L2-normalized float embedding, length === scope.dimensions */
  vector: Float32Array;
}

export interface EmbeddingStore {
  readonly scope: StoreScope;
  readonly dimensions: number;

  /** Binary-search every segment (newest first). Result is parallel to `hashes`; `null` = miss. */
  lookup(hashes: readonly Uint8Array[]): Array<RowRef | null>;

  /**
   * Quantize and append the entries as one new sealed segment, then map it.
   * Entries already present (or duplicated in the call) are not rewritten.
   * Returns refs parallel to `entries`. Safe under concurrent writers
   * (content-addressed, so a lost race just writes identical data).
   */
  insert(entries: readonly StoreEntry[]): Promise<RowRef[]>;

  /** Zero-copy views over the mmapped (or fallback-read) segment data. */
  codes(seg: number): Int8Array;
  scales(seg: number): Float32Array;

  /** Mark the store recently used (LRU input for GC). */
  touch(): void;

  /** Release mappings held by this handle. */
  close(): void;
}

/** Hash of the exact chunk text (UTF-8), 32 bytes. */
export type HashText = (text: string) => Uint8Array;
