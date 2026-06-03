import type { SemanticIndex } from "./semantic-index.ts";
import { selectTopKByDistance } from "./topk.ts";

export interface QuantizedVector {
  codes: Int8Array;
  scale: number;
}

/** Symmetric int8 quantization per vector (embeddings are L2-normalized upstream). */
export function quantizeVector(vector: Float32Array): QuantizedVector {
  let maxAbs = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i] ?? 0;
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const codes = new Int8Array(vector.length);
  if (maxAbs > 0) {
    const inv = 127 / maxAbs;
    for (let i = 0; i < vector.length; i++) {
      const value = vector[i] ?? 0;
      codes[i] = Math.max(-127, Math.min(127, Math.round(value * inv)));
    }
  }
  return { codes, scale };
}

function quantizedDot(query: QuantizedVector, docCodes: Int8Array, docScale: number): number {
  let sum = 0;
  const q = query.codes;
  for (let i = 0; i < q.length; i++) {
    sum += (q[i] ?? 0) * (docCodes[i] ?? 0);
  }
  return sum * query.scale * docScale;
}

/** int8 codes + per-vector scale; ~4x smaller than float32 at same dimensionality. */
export class QuantizedVectorIndex implements SemanticIndex {
  private readonly codes: Int8Array[];
  private readonly scales: Float32Array;
  private readonly dim: number;

  constructor(vectors: Float32Array[]) {
    if (vectors.length === 0) {
      this.dim = 0;
      this.codes = [];
      this.scales = new Float32Array(0);
      return;
    }
    this.dim = vectors[0]?.length ?? 0;
    this.codes = new Array(vectors.length);
    this.scales = new Float32Array(vectors.length);
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      if (!vector) {
        continue;
      }
      const { codes, scale } = quantizeVector(vector);
      this.codes[i] = codes;
      this.scales[i] = scale;
    }
  }

  static fromPersisted(
    codes: Int8Array[],
    scales: Float32Array,
    dim: number,
  ): QuantizedVectorIndex {
    const index = Object.create(QuantizedVectorIndex.prototype) as QuantizedVectorIndex;
    Object.assign(index, { dim, codes, scales });
    return index;
  }

  get size(): number {
    return this.codes.length;
  }

  get dimensions(): number {
    return this.dim;
  }

  memoryBytes(): number {
    return this.codes.length * this.dim + this.scales.byteLength;
  }

  vectorAt(docIndex: number): Float32Array {
    const codes = this.codes[docIndex];
    const scale = this.scales[docIndex];
    if (!codes || scale === undefined) {
      throw new Error(`Missing quantized vector at index ${docIndex}`);
    }
    const out = new Float32Array(codes.length);
    for (let i = 0; i < codes.length; i++) {
      out[i] = (codes[i] ?? 0) * scale;
    }
    let norm = 0;
    for (let i = 0; i < out.length; i++) {
      const v = out[i] ?? 0;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < out.length; i++) {
        out[i] = (out[i] ?? 0) / norm;
      }
    }
    return out;
  }

  query(
    queryVector: Float32Array,
    k: number,
    selector?: number[],
  ): { indices: number[]; distances: number[] } {
    if (k < 1) {
      throw new Error(`k should be >= 1, is now ${k}`);
    }
    if (this.size === 0) {
      return { indices: [], distances: [] };
    }

    const q = quantizeVector(queryVector);
    const indices = selector ?? Array.from({ length: this.size }, (_, i) => i);
    const effectiveK = Math.min(k, indices.length);
    if (effectiveK === 0) {
      return { indices: [], distances: [] };
    }

    const top = selectTopKByDistance(
      indices.flatMap((idx) => {
        const codes = this.codes[idx];
        if (!codes) {
          return [];
        }
        const scale = this.scales[idx];
        if (scale === undefined) {
          return [];
        }
        const similarity = quantizedDot(q, codes, scale);
        return [{ index: idx, distance: 1 - similarity }];
      }),
      effectiveK,
    );

    return {
      indices: top.map((t) => t.index),
      distances: top.map((t) => t.distance),
    };
  }

  async save(dir: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });

    const count = this.size;
    const dim = this.dim;
    const flatCodes = new Int8Array(count * dim);
    for (let i = 0; i < count; i++) {
      const codes = this.codes[i];
      if (codes) {
        flatCodes.set(codes, i * dim);
      }
    }
    await Bun.write(`${dir}/codes.bin`, flatCodes);
    await Bun.write(`${dir}/scales.bin`, this.scales);
    await Bun.write(
      `${dir}/meta.json`,
      JSON.stringify({ count, dimensions: dim, storage: "int8" }),
    );
  }

  static async load(dir: string): Promise<QuantizedVectorIndex> {
    const meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text()) as {
      count: number;
      dimensions: number;
      storage?: string;
    };
    const rawCodes = new Int8Array(await Bun.file(`${dir}/codes.bin`).arrayBuffer());
    const scales = new Float32Array(await Bun.file(`${dir}/scales.bin`).arrayBuffer());
    const index = QuantizedVectorIndex.fromPersisted(
      Array.from({ length: meta.count }, (_, i) =>
        rawCodes.subarray(i * meta.dimensions, (i + 1) * meta.dimensions),
      ),
      scales,
      meta.dimensions,
    );
    return index;
  }
}
