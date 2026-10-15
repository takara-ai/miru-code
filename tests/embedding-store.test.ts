import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashText, openEmbeddingStore } from "../src/index/embedding-store.ts";
import { quantizeVector } from "../src/index/quantize.ts";

const scope = { model: "test/model:1", dimensions: 8 };

function vec(seed: number): Float32Array {
  const v = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    v[i] = Math.sin(seed * 7 + i * 1.3);
  }
  return v;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "miru-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("embedding store", () => {
  test("roundtrip, quantized bytes, miss, dedupe", async () => {
    const store = await openEmbeddingStore(scope, root);
    const a = { hash: hashText("a"), vector: vec(1) };
    const b = { hash: hashText("b"), vector: vec(2) };
    expect(hashText("a").length).toBe(32);
    const refs = await store.insert([a, b, a]);
    expect(refs[0]).toEqual(refs[2]);
    const [ra, rb] = store.lookup([a.hash, b.hash]);
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    for (const [ref, entry] of [
      [ra, a],
      [rb, b],
    ] as const) {
      const q = quantizeVector(entry.vector);
      const codes = store
        .codes(ref?.seg as number)
        .subarray((ref?.row as number) * 8, (ref?.row as number) * 8 + 8);
      expect(Array.from(codes)).toEqual(Array.from(q.codes));
      expect(store.scales(ref?.seg as number)[ref?.row as number]).toBe(Math.fround(q.scale));
    }
    expect(store.lookup([hashText("missing")])).toEqual([null]);
    const before = refs[0];
    const again = await store.insert([a]);
    expect(again[0]).toEqual(before as { seg: number; row: number });
    store.touch();
    store.close();
  });

  test("reopen sees prior segments", async () => {
    const s1 = await openEmbeddingStore(scope, root);
    await s1.insert([{ hash: hashText("x"), vector: vec(3) }]);
    await s1.insert([{ hash: hashText("y"), vector: vec(4) }]);
    const s2 = await openEmbeddingStore(scope, root);
    expect(s2.lookup([hashText("x"), hashText("y"), hashText("z")]).map((r) => r !== null)).toEqual(
      [true, true, false],
    );
  });

  test("concurrent handles inserting same text", async () => {
    const h1 = await openEmbeddingStore(scope, root);
    const h2 = await openEmbeddingStore(scope, root);
    const entry = { hash: hashText("same"), vector: vec(5) };
    const [r1, r2] = await Promise.all([h1.insert([entry]), h2.insert([entry])]);
    expect(r1[0]).toBeDefined();
    expect(r2[0]).toBeDefined();
    const h3 = await openEmbeddingStore(scope, root);
    expect(h3.lookup([entry.hash])[0]).not.toBeNull();
  });
});
