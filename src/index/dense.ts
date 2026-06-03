/** Cosine-distance vector index with optional chunk selector. */
import { mkdir } from "node:fs/promises";
import type { SemanticIndex } from "./semantic-index.ts";
import { selectTopKByDistance } from "./topk.ts";

export class VectorIndex implements SemanticIndex {
  private vectors: Float32Array[];

  constructor(vectors: Float32Array[]) {
    this.vectors = vectors;
  }

  get size(): number {
    return this.vectors.length;
  }

  get dimensions(): number {
    return this.vectors[0]?.length ?? 0;
  }

  getVectors(): readonly Float32Array[] {
    return this.vectors;
  }

  memoryBytes(): number {
    return this.vectors.length * this.dimensions * 4;
  }

  query(
    queryVector: Float32Array,
    k: number,
    selector?: number[],
  ): { indices: number[]; distances: number[] } {
    if (k < 1) {
      throw new Error(`k should be >= 1, is now ${k}`);
    }

    const numVectors = this.vectors.length;
    if (numVectors === 0) {
      return { indices: [], distances: [] };
    }

    const indices = selector ?? Array.from({ length: numVectors }, (_, i) => i);
    const effectiveK = Math.min(k, indices.length);
    if (effectiveK === 0) {
      return { indices: [], distances: [] };
    }

    const top = selectTopKByDistance(
      indices.flatMap((idx) => {
        const vec = this.vectors[idx];
        if (!vec) {
          return [];
        }
        return [{ index: idx, distance: cosineDistance(queryVector, vec) }];
      }),
      effectiveK,
    );

    return {
      indices: top.map((t) => t.index),
      distances: top.map((t) => t.distance),
    };
  }

  async save(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });

    const dim = this.dimensions;
    const count = this.size;
    const buffer = new Float32Array(count * dim);
    for (let i = 0; i < count; i++) {
      const vec = this.vectors[i];
      if (vec) {
        buffer.set(vec, i * dim);
      }
    }
    await Bun.write(`${dir}/vectors.bin`, buffer);
    await Bun.write(
      `${dir}/meta.json`,
      JSON.stringify({ count, dimensions: dim, storage: "float32" }),
    );
  }

  static async load(dir: string): Promise<VectorIndex> {
    const meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text()) as {
      count: number;
      dimensions: number;
    };
    const raw = new Float32Array(await Bun.file(`${dir}/vectors.bin`).arrayBuffer());
    const vectors: Float32Array[] = [];
    for (let i = 0; i < meta.count; i++) {
      vectors.push(raw.subarray(i * meta.dimensions, (i + 1) * meta.dimensions));
    }
    return new VectorIndex(vectors);
  }
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return 1 - dot;
}
