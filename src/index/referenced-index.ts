import { mkdir } from "node:fs/promises";
import { type EmbeddingStore, HASH_BYTES, type RowRef } from "./embedding-store-types.ts";
import { quantizedDotFlat } from "./int8-dot.ts";
import { quantizeVector } from "./quantize.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { TopKDistanceCollector } from "./topk.ts";

/**
 * Zero-copy semantic index: vectors stay in the shared EmbeddingStore (mmapped
 * int8 segments); this index only holds per-chunk (segment, row) references and
 * the content hashes needed to re-resolve them on load.
 */
export class ReferencedVectorIndex implements SemanticIndex {
  private readonly segCodes: Array<Int8Array | undefined> = [];
  private readonly segScales: Array<Float32Array | undefined> = [];

  private constructor(
    private readonly store: EmbeddingStore,
    private readonly hashBuf: Uint8Array,
    private readonly segIds: Uint16Array,
    private readonly rowIdx: Uint32Array,
  ) {}

  static create(
    store: EmbeddingStore,
    hashes: Uint8Array,
    refs: readonly RowRef[],
  ): ReferencedVectorIndex {
    if (hashes.length !== refs.length * HASH_BYTES) {
      throw new Error(`hashes length ${hashes.length} does not match ${refs.length} refs`);
    }
    const segIds = new Uint16Array(refs.length);
    const rowIdx = new Uint32Array(refs.length);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i] as RowRef;
      segIds[i] = ref.seg;
      rowIdx[i] = ref.row;
    }
    return new ReferencedVectorIndex(store, hashes, segIds, rowIdx);
  }

  get size(): number {
    return this.segIds.length;
  }

  get dimensions(): number {
    return this.size === 0 ? 0 : this.store.dimensions;
  }

  get hashes(): Uint8Array {
    return this.hashBuf;
  }

  refAt(i: number): RowRef {
    if (i < 0 || i >= this.size) {
      throw new Error(`Missing referenced vector at index ${i}`);
    }
    return { seg: this.segIds[i] as number, row: this.rowIdx[i] as number };
  }

  /** Heap bytes only; mapped vector bytes are owned by the store. */
  memoryBytes(): number {
    return this.hashBuf.byteLength + this.segIds.byteLength + this.rowIdx.byteLength;
  }

  vectorAt(docIndex: number): Float32Array {
    const { seg, row } = this.refAt(docIndex);
    const dim = this.store.dimensions;
    const codes = this.store.codes(seg);
    const scale = this.store.scales(seg)[row] as number;
    const out = new Float32Array(dim);
    const offset = row * dim;
    for (let i = 0; i < dim; i++) {
      out[i] = (codes[offset + i] ?? 0) * scale;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      const v = out[i] ?? 0;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        out[i] = (out[i] ?? 0) / norm;
      }
    }
    return out;
  }

  query(
    queryVector: Float32Array,
    k: number,
    selector?: readonly number[],
  ): { indices: number[]; distances: number[] } {
    if (k < 1) {
      throw new Error(`k should be >= 1, is now ${k}`);
    }
    const count = this.size;
    if (count === 0) {
      return { indices: [], distances: [] };
    }
    const q = quantizeVector(queryVector);
    const effectiveK = Math.min(k, selector?.length ?? count);
    if (effectiveK === 0) {
      return { indices: [], distances: [] };
    }

    const dim = this.store.dimensions;
    const segIds = this.segIds;
    const rowIdx = this.rowIdx;
    const segCodes = this.segCodes;
    const segScales = this.segScales;
    const store = this.store;
    const collector = new TopKDistanceCollector(effectiveK);
    const score = (i: number): void => {
      const seg = segIds[i] as number;
      let codes = segCodes[seg];
      let scales = segScales[seg];
      if (!codes || !scales) {
        codes = store.codes(seg);
        scales = store.scales(seg);
        segCodes[seg] = codes;
        segScales[seg] = scales;
      }
      const row = rowIdx[i] as number;
      const scale = scales[row];
      if (scale === undefined) {
        return;
      }
      collector.offer(i, 1 - quantizedDotFlat(q, codes, row * dim, dim, scale));
    };

    if (selector) {
      for (const idx of selector) {
        if (idx >= 0 && idx < count) {
          score(idx);
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        score(i);
      }
    }

    const top = collector.finish();
    return { indices: top.map((t) => t.index), distances: top.map((t) => t.distance) };
  }

  /** New index = kept entries in order, then `added` appended. No vector bytes are touched. */
  withChanges(
    removedDocs: ReadonlySet<number>,
    added: { hashes: Uint8Array; refs: readonly RowRef[] },
  ): ReferencedVectorIndex {
    if (added.hashes.length !== added.refs.length * HASH_BYTES) {
      throw new Error("added hashes length does not match added refs");
    }
    let kept = 0;
    for (let i = 0; i < this.size; i++) {
      if (!removedDocs.has(i)) {
        kept++;
      }
    }
    const total = kept + added.refs.length;
    const hashes = new Uint8Array(total * HASH_BYTES);
    const segIds = new Uint16Array(total);
    const rowIdx = new Uint32Array(total);
    let o = 0;
    for (let i = 0; i < this.size; i++) {
      if (removedDocs.has(i)) {
        continue;
      }
      hashes.set(this.hashBuf.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES), o * HASH_BYTES);
      segIds[o] = this.segIds[i] as number;
      rowIdx[o] = this.rowIdx[i] as number;
      o++;
    }
    hashes.set(added.hashes, o * HASH_BYTES);
    for (let j = 0; j < added.refs.length; j++) {
      const ref = added.refs[j] as RowRef;
      segIds[o + j] = ref.seg;
      rowIdx[o + j] = ref.row;
    }
    return new ReferencedVectorIndex(this.store, hashes, segIds, rowIdx);
  }

  async save(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await Bun.write(`${dir}/hashes.bin`, this.hashBuf);
    await Bun.write(
      `${dir}/meta.json`,
      JSON.stringify({
        count: this.size,
        dimensions: this.store.dimensions,
        storage: "referenced",
      }),
    );
  }

  /** Returns null if the files are absent/inconsistent or any hash is missing from the store. */
  static async load(dir: string, store: EmbeddingStore): Promise<ReferencedVectorIndex | null> {
    let meta: { count: number; dimensions: number; storage?: string };
    let hashes: Uint8Array;
    try {
      meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text());
      hashes = new Uint8Array(await Bun.file(`${dir}/hashes.bin`).arrayBuffer());
    } catch {
      return null;
    }
    if (
      meta.storage !== "referenced" ||
      meta.dimensions !== store.dimensions ||
      hashes.length !== meta.count * HASH_BYTES
    ) {
      return null;
    }
    const keys: Uint8Array[] = new Array(meta.count);
    for (let i = 0; i < meta.count; i++) {
      keys[i] = hashes.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES);
    }
    const refs = store.lookup(keys);
    for (const ref of refs) {
      if (ref === null) {
        return null;
      }
    }
    return ReferencedVectorIndex.create(store, hashes, refs as RowRef[]);
  }
}
