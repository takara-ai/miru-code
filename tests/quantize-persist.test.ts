import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSemantic, saveSemantic } from "../src/index/persistence.ts";
import { QuantizedVectorIndex } from "../src/index/quantize.ts";
import { unitVector } from "./test-helpers.ts";

describe("QuantizedVectorIndex persistence", () => {
  test("save and load round-trip preserves query scores", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-quant-"));
    try {
      const vectors = [unitVector(8, 0, 1), unitVector(8, 1, 1), unitVector(8, 2, 1)];
      const index = new QuantizedVectorIndex(vectors);
      await saveSemantic(index, dir);

      const loaded = await QuantizedVectorIndex.load(dir);
      const query = unitVector(8, 0, 0.9);
      const before = index.query(query, 3);
      const after = loaded.query(query, 3);

      expect(after.indices).toEqual(before.indices);
      for (let i = 0; i < before.distances.length; i++) {
        expect(after.distances[i]).toBeCloseTo(before.distances[i] ?? 0, 5);
      }
      expect(loaded.memoryBytes()).toBe(index.memoryBytes());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSemantic returns quantized index for int8 storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-quant-"));
    try {
      const index = new QuantizedVectorIndex([unitVector(8, 0, 1), unitVector(8, 1, 0.3)]);
      await saveSemantic(index, dir);
      const loaded = await loadSemantic(dir);
      expect(loaded).toBeInstanceOf(QuantizedVectorIndex);
      expect(loaded.dimensions).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
