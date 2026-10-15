import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashText, openEmbeddingStore } from "../src/index/embedding-store.ts";
import { compactEmbeddingStore, gcEmbeddingStores } from "../src/index/embedding-store-gc.ts";

const scope = { model: "gc-model", dimensions: 8 };

function vec(seed: number): Float32Array {
  const v = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    v[i] = Math.cos(seed * 3 + i);
  }
  return v;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "miru-gc-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fill(n: number) {
  const store = await openEmbeddingStore(scope, root);
  for (let i = 0; i < n; i++) {
    await store.insert([{ hash: hashText(`t${i}`), vector: vec(i) }]);
    await Bun.sleep(2);
  }
  store.close();
}

describe("embedding store gc", () => {
  test("cap enforcement removes segments", async () => {
    await fill(4);
    const res = await gcEmbeddingStores({ cacheRoot: root, maxBytes: 0 });
    expect(res.removedSegments).toBe(4);
    expect(res.freedBytes).toBeGreaterThan(0);
    const store = await openEmbeddingStore(scope, root);
    expect(store.lookup([hashText("t0")])).toEqual([null]);
  });

  test("under cap removes nothing", async () => {
    await fill(2);
    const res = await gcEmbeddingStores({ cacheRoot: root, maxBytes: 1e9 });
    expect(res.removedSegments).toBe(0);
  });

  test("compaction preserves lookups", async () => {
    await fill(12);
    const dir = join(root, "embeddings", "gc-model-8");
    const before = readdirSync(dir).filter((f) => f.endsWith(".hashes.bin")).length;
    expect(before).toBe(12);
    const merged = await compactEmbeddingStore(dir);
    expect(merged).toBe(12);
    expect(readdirSync(dir).filter((f) => f.endsWith(".hashes.bin")).length).toBe(1);
    const store = await openEmbeddingStore(scope, root);
    const hashes = Array.from({ length: 12 }, (_, i) => hashText(`t${i}`));
    expect(store.lookup(hashes).every((r) => r !== null)).toBe(true);
  });
});
