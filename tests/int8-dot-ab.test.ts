import { describe, expect, test } from "bun:test";
import { quantizedDotFlat, quantizedDotFlatScalar } from "../src/index/int8-dot.ts";
import { quantizeVector } from "../src/index/quantize.ts";
import { normalizedRandom, seededRandom } from "./test-helpers.ts";

describe("int8 dot A/B", () => {
  const dim = 256;
  const rand = seededRandom(17);

  test("unroll8 matches scalar exactly on random vectors", () => {
    let mismatches = 0;
    for (let d = 0; d < 5_000; d++) {
      const doc = normalizedRandom(dim, rand);
      const query = normalizedRandom(dim, rand);
      const q = quantizeVector(query);
      const { codes, scale } = quantizeVector(doc);
      const scalar = quantizedDotFlatScalar(q, codes, 0, dim, scale);
      const optimized = quantizedDotFlat(q, codes, 0, dim, scale);
      if (scalar !== optimized) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  test("unroll8 is not slower than scalar on full scans", () => {
    const count = 10_000;
    const codes = new Int8Array(count * dim);
    const scales = new Float32Array(count);
    for (let d = 0; d < count; d++) {
      const { codes: c, scale } = quantizeVector(normalizedRandom(dim, rand));
      codes.set(c, d * dim);
      scales[d] = scale;
    }
    const q = quantizeVector(normalizedRandom(dim, rand));

    const bench = (fn: () => void) => {
      for (let i = 0; i < 5; i++) fn();
      const t0 = Bun.nanoseconds();
      for (let i = 0; i < 20; i++) fn();
      return (Bun.nanoseconds() - t0) / 1e6 / 20;
    };

    const scalarMs = bench(() => {
      let acc = 0;
      for (let d = 0; d < count; d++) {
        const scale = scales[d];
        if (scale === undefined) {
          throw new Error("unexpected missing scale");
        }
        acc += quantizedDotFlatScalar(q, codes, d * dim, dim, scale);
      }
      if (Number.isNaN(acc)) throw new Error("unexpected");
    });
    const optimizedMs = bench(() => {
      let acc = 0;
      for (let d = 0; d < count; d++) {
        const scale = scales[d];
        if (scale === undefined) {
          throw new Error("unexpected missing scale");
        }
        acc += quantizedDotFlat(q, codes, d * dim, dim, scale);
      }
      if (Number.isNaN(acc)) throw new Error("unexpected");
    });

    console.log(
      `[int8 dot A/B] scalar=${scalarMs.toFixed(2)}ms unroll8=${optimizedMs.toFixed(2)}ms speedup=${(scalarMs / optimizedMs).toFixed(2)}x`,
    );
    expect(optimizedMs).toBeLessThanOrEqual(scalarMs * 1.05);
  });
});
