import { describe, expect, test } from "bun:test";
import { VectorIndex } from "../src/index/dense.ts";
import { QuantizedVectorIndex, quantizeVector } from "../src/index/quantize.ts";
import { normalizedRandom, seededRandom } from "./test-helpers.ts";

describe("QuantizedVectorIndex", () => {
  test("uses less memory than float32 index", () => {
    const rand = seededRandom(42);
    const vectors = Array.from({ length: 100 }, () => normalizedRandom(256, rand));
    const floatIndex = new VectorIndex(vectors);
    const quantIndex = new QuantizedVectorIndex(vectors);
    expect(quantIndex.memoryBytes()).toBeLessThan(floatIndex.memoryBytes() * 0.3);
  });

  test("top-1 match rate stays high on random unit vectors", () => {
    const dim = 256;
    const rand = seededRandom(7);
    const vectors = Array.from({ length: 200 }, () => normalizedRandom(dim, rand));
    const floatIndex = new VectorIndex(vectors);
    const quantIndex = new QuantizedVectorIndex(vectors);

    let top1Match = 0;
    const queries = 40;
    const queryRand = seededRandom(99);
    for (let q = 0; q < queries; q++) {
      const query = normalizedRandom(dim, queryRand);
      const floatTop = floatIndex.query(query, 1).indices[0];
      const quantTop = quantIndex.query(query, 1).indices[0];
      if (floatTop === quantTop) {
        top1Match++;
      }
    }
    expect(top1Match / queries).toBeGreaterThan(0.85);
  });

  test("quantizeVector round-trips approximately", () => {
    const v = normalizedRandom(256, seededRandom(3));
    const { codes, scale } = quantizeVector(v);
    let err = 0;
    for (let i = 0; i < v.length; i++) {
      const approx = (codes[i] ?? 0) * scale;
      err += Math.abs(approx - (v[i] ?? 0));
    }
    expect(err / v.length).toBeLessThan(0.02);
  });
});
