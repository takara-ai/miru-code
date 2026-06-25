/** Uncompressed float32 semantic index. Debug/precision baseline only; production uses int8. */
import type { SemanticIndex } from "./semantic-index.ts";
import { TopKDistanceCollector } from "./topk.ts";

function cosineDistanceFlat(
  data: Float32Array,
  dim: number,
  docIndex: number,
  query: Float32Array,
): number {
  const offset = docIndex * dim;
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += (query[i] ?? 0) * (data[offset + i] ?? 0);
  }
  return 1 - dot;
}

export class VectorIndex implements SemanticIndex {
  private readonly data: Float32Array;
  private readonly count: number;
  private readonly dim: number;
  private vectorsCache: Float32Array[] | null = null;

  constructor(vectors: Float32Array[]) {
    if (vectors.length === 0) {
      this.count = 0;
      this.dim = 0;
      this.data = new Float32Array(0);
      return;
    }
    this.count = vectors.length;
    this.dim = vectors[0]?.length ?? 0;
    this.data = new Float32Array(this.count * this.dim);
    for (let i = 0; i < this.count; i++) {
      const vec = vectors[i];
      if (vec) {
        this.data.set(vec, i * this.dim);
      }
    }
  }

  static fromFlatBuffer(data: Float32Array, count: number, dim: number): VectorIndex {
    const index = Object.create(VectorIndex.prototype) as VectorIndex;
    Object.assign(index, { data, count, dim });
    return index;
  }

  get size(): number {
    return this.count;
  }

  get dimensions(): number {
    return this.dim;
  }

  getVectors(): readonly Float32Array[] {
    if (this.vectorsCache) {
      return this.vectorsCache;
    }
    const vectors: Float32Array[] = [];
    for (let i = 0; i < this.count; i++) {
      vectors.push(this.data.subarray(i * this.dim, (i + 1) * this.dim));
    }
    this.vectorsCache = vectors;
    return vectors;
  }

  vectorAt(docIndex: number): Float32Array {
    if (docIndex < 0 || docIndex >= this.count) {
      throw new Error(`Missing vector at index ${docIndex}`);
    }
    return this.data.subarray(docIndex * this.dim, (docIndex + 1) * this.dim);
  }

  memoryBytes(): number {
    return this.count * this.dim * 4;
  }

  query(
    queryVector: Float32Array,
    k: number,
    selector?: readonly number[],
  ): { indices: number[]; distances: number[] } {
    if (k < 1) {
      throw new Error(`k should be >= 1, is now ${k}`);
    }
    if (this.count === 0) {
      return { indices: [], distances: [] };
    }

    const effectiveK = Math.min(k, selector?.length ?? this.count);
    if (effectiveK === 0) {
      return { indices: [], distances: [] };
    }

    const collector = new TopKDistanceCollector(effectiveK);
    if (selector) {
      for (const idx of selector) {
        if (idx < 0 || idx >= this.count) {
          continue;
        }
        collector.offer(idx, cosineDistanceFlat(this.data, this.dim, idx, queryVector));
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        collector.offer(i, cosineDistanceFlat(this.data, this.dim, i, queryVector));
      }
    }

    const top = collector.finish();
    return {
      indices: top.map((t) => t.index),
      distances: top.map((t) => t.distance),
    };
  }

  async save(dir: string): Promise<void> {
    await Bun.write(`${dir}/vectors.bin`, this.data);
    await Bun.write(
      `${dir}/meta.json`,
      JSON.stringify({ count: this.count, dimensions: this.dim, storage: "float32" }),
    );
  }

  static async load(dir: string): Promise<VectorIndex> {
    const meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text()) as {
      count: number;
      dimensions: number;
    };
    const data = new Float32Array(await Bun.file(`${dir}/vectors.bin`).arrayBuffer());
    return VectorIndex.fromFlatBuffer(data, meta.count, meta.dimensions);
  }
}
