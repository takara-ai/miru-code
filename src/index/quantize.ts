import { quantizedDotFlat } from "./int8-dot.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { TopKDistanceCollector } from "./topk.ts";

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

/** Production semantic index: symmetric int8 codes with per-vector scale (~4x less RAM than float32). */
export class QuantizedVectorIndex implements SemanticIndex {
  private readonly codes: Int8Array;
  private readonly scales: Float32Array;
  private readonly count: number;
  private readonly dim: number;

  constructor(vectors: Float32Array[]) {
    if (vectors.length === 0) {
      this.count = 0;
      this.dim = 0;
      this.codes = new Int8Array(0);
      this.scales = new Float32Array(0);
      return;
    }
    this.count = vectors.length;
    this.dim = vectors[0]?.length ?? 0;
    this.codes = new Int8Array(this.count * this.dim);
    this.scales = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const vector = vectors[i];
      if (!vector) {
        continue;
      }
      const { codes, scale } = quantizeVector(vector);
      this.codes.set(codes, i * this.dim);
      this.scales[i] = scale;
    }
  }

  static fromPersisted(
    codes: Int8Array,
    scales: Float32Array,
    count: number,
    dim: number,
  ): QuantizedVectorIndex {
    const index = Object.create(QuantizedVectorIndex.prototype) as QuantizedVectorIndex;
    Object.assign(index, { codes, scales, count, dim });
    return index;
  }

  get size(): number {
    return this.count;
  }

  get dimensions(): number {
    return this.dim;
  }

  memoryBytes(): number {
    return this.count * this.dim + this.scales.byteLength;
  }

  vectorAt(docIndex: number): Float32Array {
    if (docIndex < 0 || docIndex >= this.count) {
      throw new Error(`Missing quantized vector at index ${docIndex}`);
    }
    const offset = docIndex * this.dim;
    const scale = this.scales[docIndex];
    if (scale === undefined) {
      throw new Error(`Missing quantized vector at index ${docIndex}`);
    }
    const out = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      out[i] = (this.codes[offset + i] ?? 0) * scale;
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
    selector?: readonly number[],
  ): { indices: number[]; distances: number[] } {
    if (k < 1) {
      throw new Error(`k should be >= 1, is now ${k}`);
    }
    if (this.count === 0) {
      return { indices: [], distances: [] };
    }

    const q = quantizeVector(queryVector);
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
        const scale = this.scales[idx];
        if (scale === undefined) {
          continue;
        }
        const similarity = quantizedDotFlat(q, this.codes, idx * this.dim, this.dim, scale);
        collector.offer(idx, 1 - similarity);
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        const scale = this.scales[i];
        if (scale === undefined) {
          continue;
        }
        const similarity = quantizedDotFlat(q, this.codes, i * this.dim, this.dim, scale);
        collector.offer(i, 1 - similarity);
      }
    }

    const top = collector.finish();
    return {
      indices: top.map((t) => t.index),
      distances: top.map((t) => t.distance),
    };
  }

  async save(dir: string): Promise<void> {
    await Bun.write(`${dir}/codes.bin`, this.codes);
    await Bun.write(`${dir}/scales.bin`, this.scales);
    await Bun.write(
      `${dir}/meta.json`,
      JSON.stringify({ count: this.count, dimensions: this.dim, storage: "int8" }),
    );
  }

  static async load(dir: string): Promise<QuantizedVectorIndex> {
    const meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text()) as {
      count: number;
      dimensions: number;
      storage?: string;
    };
    const codes = new Int8Array(await Bun.file(`${dir}/codes.bin`).arrayBuffer());
    const scales = new Float32Array(await Bun.file(`${dir}/scales.bin`).arrayBuffer());
    return QuantizedVectorIndex.fromPersisted(codes, scales, meta.count, meta.dimensions);
  }
}
