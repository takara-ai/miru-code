import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorIndex } from "../src/index/dense.ts";

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("VectorIndex", () => {
  test("handles empty indexes and invalid query arguments", () => {
    const empty = new VectorIndex([]);
    expect(empty.size).toBe(0);
    expect(empty.dimensions).toBe(0);
    expect(empty.memoryBytes()).toBe(0);
    expect(empty.query(new Float32Array([1]), 1)).toEqual({ indices: [], distances: [] });
    const index = new VectorIndex([new Float32Array([1, 0])]);
    expect(() => index.query(new Float32Array([1, 0]), 0)).toThrow("k should be >= 1");
    expect(index.query(new Float32Array([1, 0]), 1, [])).toEqual({ indices: [], distances: [] });
    expect(index.query(new Float32Array([1, 0]), 1, [-1, 4])).toEqual({
      indices: [],
      distances: [],
    });
  });

  test("supports flat buffers, vector access, query, and persistence", async () => {
    const index = new VectorIndex([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(index.size).toBe(2);
    expect(index.dimensions).toBe(2);
    expect(index.memoryBytes()).toBe(16);
    expect(Array.from(index.vectorAt(1))).toEqual([0, 1]);
    expect(() => index.vectorAt(-1)).toThrow("Missing vector");
    expect(index.getVectors()).toBe(index.getVectors());
    const flat = VectorIndex.fromFlatBuffer(new Float32Array([1, 0]), 1, 2);
    expect(flat.dimensions).toBe(2);
    expect(flat.query(new Float32Array([1, 0]), 1).indices).toEqual([0]);
    tempDir = await mkdtemp(join(tmpdir(), "miru-dense-"));
    await index.save(tempDir);
    const restored = await VectorIndex.load(tempDir);
    expect(restored.size).toBe(2);
    expect(Array.from(restored.vectorAt(0))).toEqual([1, 0]);
  });
});
