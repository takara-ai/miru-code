import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbeddingStore,
  HASH_BYTES,
  type RowRef,
  type StoreEntry,
} from "../src/index/embedding-store-types.ts";
import { QuantizedVectorIndex, quantizeVector } from "../src/index/quantize.ts";
import { ReferencedVectorIndex } from "../src/index/referenced-index.ts";
import { vectorAt } from "../src/index/vectors.ts";
import { normalizedRandom, seededRandom } from "./test-helpers.ts";

const DIM = 64;

class FakeStore implements EmbeddingStore {
  readonly scope = { model: "fake", dimensions: DIM };
  readonly dimensions = DIM;
  private segs: Array<{ keys: string[]; codes: Int8Array; scales: Float32Array }> = [];

  lookup(hashes: readonly Uint8Array[]): Array<RowRef | null> {
    return hashes.map((h) => {
      const key = Buffer.from(h).toString("hex");
      for (let seg = this.segs.length - 1; seg >= 0; seg--) {
        const row = this.segs[seg]?.keys.indexOf(key) ?? -1;
        if (row >= 0) {
          return { seg, row };
        }
      }
      return null;
    });
  }

  async insert(entries: readonly StoreEntry[]): Promise<RowRef[]> {
    const seg = this.segs.length;
    const codes = new Int8Array(entries.length * DIM);
    const scales = new Float32Array(entries.length);
    entries.forEach((e, i) => {
      const q = quantizeVector(e.vector);
      codes.set(q.codes, i * DIM);
      scales[i] = q.scale;
    });
    this.segs.push({
      keys: entries.map((e) => Buffer.from(e.hash).toString("hex")),
      codes,
      scales,
    });
    return entries.map((_, row) => ({ seg, row }));
  }

  codes(seg: number): Int8Array {
    return this.segs[seg]?.codes as Int8Array;
  }
  scales(seg: number): Float32Array {
    return this.segs[seg]?.scales as Float32Array;
  }
  touch(): void {}
  close(): void {}
}

function makeHash(n: number): Uint8Array {
  const h = new Uint8Array(HASH_BYTES);
  new DataView(h.buffer).setUint32(0, n + 1);
  h[31] = 7;
  return h;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.length * HASH_BYTES);
  for (const [i, p] of parts.entries()) {
    out.set(p, i * HASH_BYTES);
  }
  return out;
}

async function build(n: number, seed = 1) {
  const rand = seededRandom(seed);
  const vectors = Array.from({ length: n }, () => normalizedRandom(DIM, rand));
  const store = new FakeStore();
  const hashList = vectors.map((_, i) => makeHash(i));
  // Split across two segments to exercise multi-segment lookup.
  const half = Math.floor(n / 2);
  const refsA = await store.insert(
    vectors.slice(0, half).map((vector, i) => ({ hash: hashList[i] as Uint8Array, vector })),
  );
  const refsB = await store.insert(
    vectors.slice(half).map((vector, i) => ({ hash: hashList[half + i] as Uint8Array, vector })),
  );
  const index = ReferencedVectorIndex.create(store, concat(hashList), [...refsA, ...refsB]);
  return { store, vectors, hashList, index };
}

describe("ReferencedVectorIndex", () => {
  test("query parity with QuantizedVectorIndex", async () => {
    const { vectors, index } = await build(200);
    const quant = new QuantizedVectorIndex(vectors);
    const rand = seededRandom(99);
    const selector = Array.from({ length: 60 }, (_, i) => i * 3);
    for (let t = 0; t < 5; t++) {
      const q = normalizedRandom(DIM, rand);
      expect(index.query(q, 10)).toEqual(quant.query(q, 10));
      expect(index.query(q, 10, selector)).toEqual(quant.query(q, 10, selector));
    }
    expect(index.query(vectors[0] as Float32Array, 5, [])).toEqual({ indices: [], distances: [] });
    expect(() => index.query(vectors[0] as Float32Array, 0)).toThrow();
    expect(index.size).toBe(200);
    expect(index.dimensions).toBe(DIM);
  });

  test("vectorAt matches QuantizedVectorIndex", async () => {
    const { vectors, index } = await build(10);
    const quant = new QuantizedVectorIndex(vectors);
    for (let i = 0; i < 10; i++) {
      expect(vectorAt(index, i)).toEqual(quant.vectorAt(i));
    }
  });

  test("withChanges keeps rows byte-identical and does not drift", async () => {
    const { store, vectors, hashList, index } = await build(60);
    let current = index;
    let expectedVecs = [...vectors];
    let expectedHashes = [...hashList];
    const rand = seededRandom(5);
    for (let round = 0; round < 20; round++) {
      const removed = new Set([round % current.size, (round * 7 + 3) % current.size]);
      const fresh = [normalizedRandom(DIM, rand), normalizedRandom(DIM, rand)];
      const freshHashes = fresh.map((_, i) => makeHash(1000 + round * 2 + i));
      const refs = await store.insert(
        fresh.map((vector, i) => ({ hash: freshHashes[i] as Uint8Array, vector })),
      );
      current = current.withChanges(removed, { hashes: concat(freshHashes), refs });
      expectedVecs = [...expectedVecs.filter((_, i) => !removed.has(i)), ...fresh];
      expectedHashes = [...expectedHashes.filter((_, i) => !removed.has(i)), ...freshHashes];
    }
    const reference = new QuantizedVectorIndex(expectedVecs);
    expect(current.size).toBe(expectedVecs.length);
    expect(current.hashes).toEqual(concat(expectedHashes));
    const q = normalizedRandom(DIM, rand);
    expect(current.query(q, 15)).toEqual(reference.query(q, 15));
    for (let i = 0; i < current.size; i++) {
      expect(vectorAt(current, i)).toEqual(reference.vectorAt(i));
    }
  });

  test("save/load roundtrip", async () => {
    const { store, vectors, index } = await build(40);
    const dir = await mkdtemp(join(tmpdir(), "miru-ref-"));
    try {
      await index.save(dir);
      const meta = JSON.parse(await Bun.file(`${dir}/meta.json`).text());
      expect(meta).toEqual({ count: 40, dimensions: DIM, storage: "referenced" });
      const loaded = await ReferencedVectorIndex.load(dir, store);
      expect(loaded).not.toBeNull();
      const q = normalizedRandom(DIM, seededRandom(3));
      expect(loaded?.query(q, 8)).toEqual(new QuantizedVectorIndex(vectors).query(q, 8));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("load returns null when a hash is missing", async () => {
    const { index } = await build(10);
    const dir = await mkdtemp(join(tmpdir(), "miru-ref-"));
    try {
      await index.save(dir);
      expect(await ReferencedVectorIndex.load(dir, new FakeStore())).toBeNull();
      expect(await ReferencedVectorIndex.load(`${dir}/nope`, new FakeStore())).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("heap footprint is far below codes size", async () => {
    const { index } = await build(500);
    const codesBytes = 500 * DIM;
    expect(index.memoryBytes()).toBe(500 * (HASH_BYTES + 2 + 4));
    expect(index.memoryBytes()).toBeGreaterThan(0);
    // With realistic dims (e.g. 768) the ratio is ~1/20; assert the formula is dim-independent.
    expect(index.memoryBytes() / 500).toBeLessThan(codesBytes);
  });
});
