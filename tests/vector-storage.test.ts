import { describe, expect, test } from "bun:test";
import { VectorIndex } from "../src/index/dense.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { buildSemanticIndex, resolveSemanticStorage } from "../src/index/vector-storage.ts";

describe("vector storage defaults", () => {
  test("buildSemanticIndex uses int8 by default", () => {
    delete process.env.MIRU_FLOAT_VECTORS;
    expect(resolveSemanticStorage()).toBe("int8");
    const index = buildSemanticIndex([new Float32Array([1, 0, 0])]);
    expect(index).toBeInstanceOf(QuantizedVectorIndex);
  });

  test("MIRU_FLOAT_VECTORS=1 uses float32", () => {
    process.env.MIRU_FLOAT_VECTORS = "1";
    expect(resolveSemanticStorage()).toBe("float32");
    const index = buildSemanticIndex([new Float32Array([1, 0, 0])]);
    expect(index).toBeInstanceOf(VectorIndex);
    delete process.env.MIRU_FLOAT_VECTORS;
  });
});
