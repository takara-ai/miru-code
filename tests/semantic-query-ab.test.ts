import { describe, expect, test } from "bun:test";
import { VectorIndex } from "../src/index/dense.ts";
import { QuantizedVectorIndex, quantizeVector } from "../src/index/quantize.ts";
import { selectTopKByDistance } from "../src/index/topk.ts";
import { normalizedRandom, seededRandom } from "./test-helpers.ts";

type QueryResult = { indices: number[]; distances: number[] };

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return 1 - dot;
}

function quantizedDot(
  query: ReturnType<typeof quantizeVector>,
  docCodes: Int8Array,
  docScale: number,
): number {
  let sum = 0;
  const q = query.codes;
  for (let i = 0; i < q.length; i++) {
    sum += (q[i] ?? 0) * (docCodes[i] ?? 0);
  }
  return sum * query.scale * docScale;
}

/** Legacy float32 query: materialize all scores, then selectTopKByDistance. */
function queryVectorIndexLegacy(
  vectors: readonly Float32Array[],
  queryVector: Float32Array,
  k: number,
  selector?: readonly number[],
): QueryResult {
  const indices = selector ?? Array.from({ length: vectors.length }, (_, i) => i);
  const effectiveK = Math.min(k, indices.length);
  const top = selectTopKByDistance(
    indices.flatMap((idx) => {
      const vec = vectors[idx];
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

/** Legacy int8 query: materialize all scores, then selectTopKByDistance. */
function queryQuantizedIndexLegacy(
  codes: readonly Int8Array[],
  scales: Float32Array,
  queryVector: Float32Array,
  k: number,
  selector?: readonly number[],
): QueryResult {
  const q = quantizeVector(queryVector);
  const indices = selector ?? Array.from({ length: codes.length }, (_, i) => i);
  const effectiveK = Math.min(k, indices.length);
  const top = selectTopKByDistance(
    indices.flatMap((idx) => {
      const docCodes = codes[idx];
      const scale = scales[idx];
      if (!docCodes || scale === undefined) {
        return [];
      }
      const similarity = quantizedDot(q, docCodes, scale);
      return [{ index: idx, distance: 1 - similarity }];
    }),
    effectiveK,
  );
  return {
    indices: top.map((t) => t.index),
    distances: top.map((t) => t.distance),
  };
}

function benchMs(iterations: number, fn: () => void): number {
  for (let i = 0; i < Math.min(iterations, 20); i++) {
    fn();
  }
  const start = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return (Bun.nanoseconds() - start) / 1e6 / iterations;
}

function expectQueryEqual(a: QueryResult, b: QueryResult): void {
  expect(a.indices).toEqual(b.indices);
  expect(a.distances.length).toBe(b.distances.length);
  for (let i = 0; i < a.distances.length; i++) {
    expect(a.distances[i]).toBeCloseTo(b.distances[i] ?? 0, 10);
  }
}

function languageSelector(count: number, languageMod: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i % languageMod === 0) {
      out.push(i);
    }
  }
  return out;
}

describe("semantic query A/B", () => {
  const dim = 256;
  const rand = seededRandom(42);
  const vectors = Array.from({ length: 2_000 }, () => normalizedRandom(dim, rand));
  const query = normalizedRandom(dim, seededRandom(99));
  const topK = 50;
  const selector = languageSelector(vectors.length, 5);

  test("VectorIndex matches legacy behavior (unfiltered)", () => {
    const index = new VectorIndex(vectors);
    const legacy = queryVectorIndexLegacy(index.getVectors(), query, topK);
    const optimized = index.query(query, topK);
    expectQueryEqual(optimized, legacy);
  });

  test("VectorIndex matches legacy behavior (selector)", () => {
    const index = new VectorIndex(vectors);
    const legacy = queryVectorIndexLegacy(index.getVectors(), query, topK, selector);
    const optimized = index.query(query, topK, selector);
    expectQueryEqual(optimized, legacy);
  });

  test("QuantizedVectorIndex matches legacy behavior (unfiltered)", () => {
    const index = new QuantizedVectorIndex(vectors);
    const legacyCodes = vectors.map((vec) =>
      vec ? quantizeVector(vec).codes : new Int8Array(dim),
    );
    const legacyScales = new Float32Array(
      vectors.map((vec) => (vec ? quantizeVector(vec).scale : 0)),
    );
    const legacy = queryQuantizedIndexLegacy(legacyCodes, legacyScales, query, topK);
    const optimized = index.query(query, topK);
    expect(optimized.indices).toEqual(legacy.indices);
    for (let i = 0; i < optimized.distances.length; i++) {
      expect(optimized.distances[i]).toBeCloseTo(legacy.distances[i] ?? 0, 5);
    }
  });

  test("QuantizedVectorIndex matches legacy behavior (selector)", () => {
    const index = new QuantizedVectorIndex(vectors);
    const legacyCodes = vectors.map((vec) =>
      vec ? quantizeVector(vec).codes : new Int8Array(dim),
    );
    const legacyScales = new Float32Array(
      vectors.map((vec) => (vec ? quantizeVector(vec).scale : 0)),
    );
    const legacy = queryQuantizedIndexLegacy(legacyCodes, legacyScales, query, topK, selector);
    const optimized = index.query(query, topK, selector);
    expect(optimized.indices).toEqual(legacy.indices);
    for (let i = 0; i < optimized.distances.length; i++) {
      expect(optimized.distances[i]).toBeCloseTo(legacy.distances[i] ?? 0, 5);
    }
  });

  test("benchmark summary: legacy vs optimized (logs speedup)", () => {
    const large = Array.from({ length: 20_000 }, () => normalizedRandom(dim, seededRandom(7)));
    const floatIndex = new VectorIndex(large);
    const floatVectors = floatIndex.getVectors();
    const quantIndex = new QuantizedVectorIndex(large);
    const legacyCodes = large.map((vec) => (vec ? quantizeVector(vec).codes : new Int8Array(dim)));
    const legacyScales = new Float32Array(
      large.map((vec) => (vec ? quantizeVector(vec).scale : 0)),
    );
    const q = normalizedRandom(dim, seededRandom(8));
    const sel = languageSelector(large.length, 5);

    const scenarios = [
      {
        label: "float32 selector",
        legacyMs: benchMs(30, () => {
          queryVectorIndexLegacy(floatVectors, q, topK, sel);
        }),
        optimizedMs: benchMs(30, () => {
          floatIndex.query(q, topK, sel);
        }),
      },
      {
        label: "float32 unfiltered",
        legacyMs: benchMs(20, () => {
          queryVectorIndexLegacy(floatVectors, q, topK);
        }),
        optimizedMs: benchMs(20, () => {
          floatIndex.query(q, topK);
        }),
      },
      {
        label: "int8 selector",
        legacyMs: benchMs(30, () => {
          queryQuantizedIndexLegacy(legacyCodes, legacyScales, q, topK, sel);
        }),
        optimizedMs: benchMs(30, () => {
          quantIndex.query(q, topK, sel);
        }),
      },
      {
        label: "int8 unfiltered",
        legacyMs: benchMs(20, () => {
          queryQuantizedIndexLegacy(legacyCodes, legacyScales, q, topK);
        }),
        optimizedMs: benchMs(20, () => {
          quantIndex.query(q, topK);
        }),
      },
    ] as const;

    console.log("\nsemantic query A/B (20k chunks, dim 256, topK=50):");
    for (const scenario of scenarios) {
      const speedup = scenario.legacyMs / scenario.optimizedMs;
      console.log(
        `  ${scenario.label.padEnd(20)} legacy=${scenario.legacyMs.toFixed(3)}ms optimized=${scenario.optimizedMs.toFixed(3)}ms speedup=${speedup.toFixed(2)}x`,
      );
      // Guard against catastrophic regressions only; exact speedup varies by machine/load.
      expect(speedup).toBeGreaterThan(0.75);
    }
  });
});
