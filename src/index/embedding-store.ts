/**
 * Content-addressed, mmapped int8 embedding store. See embedding-store-types.ts for the contract.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveCacheFolder } from "../cache.ts";
import {
  type EmbeddingStore,
  HASH_BYTES,
  type RowRef,
  type StoreEntry,
  type StoreScope,
} from "./embedding-store-types.ts";
import { quantizeVector } from "./quantize.ts";

export const LAST_USED_FILE = ".last-used";
const SEG_PREFIX = "seg-";

export function hashText(text: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return new Uint8Array(hasher.digest() as Uint8Array);
}

export function embeddingsRoot(cacheRoot: string = resolveCacheFolder()): string {
  return join(cacheRoot, "embeddings");
}

export function scopeDirName(scope: StoreScope): string {
  const model = scope.model.replace(/[^A-Za-z0-9._-]+/g, "_") || "model";
  return `${model}-${scope.dimensions}`;
}

export function segmentPaths(dir: string, id: string) {
  const base = join(dir, `${SEG_PREFIX}${id}`);
  return {
    hashes: `${base}.hashes.bin`,
    codes: `${base}.codes.bin`,
    scales: `${base}.scales.bin`,
  };
}

/** Ids of segments whose hashes file (written last) is present, oldest first. */
export function listSegmentIds(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const suffix = ".hashes.bin";
  return names
    .filter((n) => n.startsWith(SEG_PREFIX) && n.endsWith(suffix))
    .map((n) => n.slice(SEG_PREFIX.length, n.length - suffix.length))
    .sort();
}

export function newSegmentId(): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `${time}-${rand}`;
}

function mapFile(path: string): Uint8Array {
  try {
    return Bun.mmap(path);
  } catch {
    // Fallback: copy into a fresh (aligned) buffer.
    return new Uint8Array(readFileSync(path));
  }
}

interface Segment {
  id: string;
  count: number;
  hashes: Uint8Array;
  codes: Int8Array;
  scales: Float32Array;
}

function loadSegment(dir: string, id: string, dimensions: number): Segment | null {
  try {
    const p = segmentPaths(dir, id);
    const hashes = mapFile(p.hashes);
    const codesRaw = mapFile(p.codes);
    const scalesRaw = mapFile(p.scales);
    const count = hashes.byteLength / HASH_BYTES;
    if (
      count === 0 ||
      !Number.isInteger(count) ||
      codesRaw.byteLength !== count * dimensions ||
      scalesRaw.byteLength !== count * 4 ||
      scalesRaw.byteOffset % 4 !== 0
    ) {
      return null;
    }
    return {
      id,
      count,
      hashes,
      codes: new Int8Array(codesRaw.buffer, codesRaw.byteOffset, codesRaw.byteLength),
      scales: new Float32Array(scalesRaw.buffer, scalesRaw.byteOffset, count),
    };
  } catch {
    return null;
  }
}

export function compareHash(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number): number {
  for (let i = 0; i < HASH_BYTES; i++) {
    const d = (a[aOff + i] as number) - (b[bOff + i] as number);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function findRow(seg: Segment, hash: Uint8Array): number {
  let lo = 0;
  let hi = seg.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = compareHash(seg.hashes, mid * HASH_BYTES, hash, 0);
    if (c === 0) {
      return mid;
    }
    if (c < 0) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/** Write a complete segment (temp files, then rename; hashes last). Returns its id. */
export async function writeSegment(
  dir: string,
  hashes: Uint8Array,
  codes: Int8Array,
  scales: Float32Array,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const id = newSegmentId();
  const final = segmentPaths(dir, id);
  const tmp = {
    hashes: `${final.hashes}.tmp`,
    codes: `${final.codes}.tmp`,
    scales: `${final.scales}.tmp`,
  };
  try {
    await Promise.all([
      Bun.write(tmp.codes, codes),
      Bun.write(tmp.scales, scales),
      Bun.write(tmp.hashes, hashes),
    ]);
    await rename(tmp.codes, final.codes);
    await rename(tmp.scales, final.scales);
    await rename(tmp.hashes, final.hashes);
  } catch (error) {
    await Promise.all(
      [tmp.codes, tmp.scales, tmp.hashes, final.codes, final.scales].map((f) =>
        rm(f, { force: true }).catch(() => undefined),
      ),
    );
    throw error;
  }
  return id;
}

class MappedEmbeddingStore implements EmbeddingStore {
  readonly dimensions: number;
  private readonly segments: Segment[] = [];

  constructor(
    readonly scope: StoreScope,
    private readonly dir: string,
  ) {
    this.dimensions = scope.dimensions;
    for (const id of listSegmentIds(dir)) {
      const seg = loadSegment(dir, id, this.dimensions);
      if (seg) {
        this.segments.push(seg);
      }
    }
  }

  private find(hash: Uint8Array): RowRef | null {
    for (let s = this.segments.length - 1; s >= 0; s--) {
      const seg = this.segments[s] as Segment;
      const row = findRow(seg, hash);
      if (row >= 0) {
        return { seg: s, row };
      }
    }
    return null;
  }

  lookup(hashes: readonly Uint8Array[]): Array<RowRef | null> {
    return hashes.map((h) => this.find(h));
  }

  async insert(entries: readonly StoreEntry[]): Promise<RowRef[]> {
    // Pick entries to write: unique within call and absent from existing segments.
    const seen = new Set<string>();
    const fresh: StoreEntry[] = [];
    for (const entry of entries) {
      if (entry.vector.length !== this.dimensions) {
        throw new Error(
          `Vector length ${entry.vector.length} does not match store dimensions ${this.dimensions}`,
        );
      }
      const key = Buffer.from(entry.hash).toString("latin1");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (!this.find(entry.hash)) {
        fresh.push(entry);
      }
    }

    if (fresh.length > 0) {
      fresh.sort((a, b) => compareHash(a.hash, 0, b.hash, 0));
      const n = fresh.length;
      const dim = this.dimensions;
      const hashes = new Uint8Array(n * HASH_BYTES);
      const codes = new Int8Array(n * dim);
      const scales = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const entry = fresh[i] as StoreEntry;
        hashes.set(entry.hash, i * HASH_BYTES);
        const q = quantizeVector(entry.vector);
        codes.set(q.codes, i * dim);
        scales[i] = q.scale;
      }
      const id = await writeSegment(this.dir, hashes, codes, scales);
      const seg = loadSegment(this.dir, id, dim);
      if (!seg) {
        throw new Error(`Failed to map embedding segment ${id}`);
      }
      this.segments.push(seg);
    }

    return entries.map((entry) => {
      const ref = this.find(entry.hash);
      if (!ref) {
        throw new Error("Embedding store insert lost an entry");
      }
      return ref;
    });
  }

  private segment(seg: number): Segment {
    const s = this.segments[seg];
    if (!s) {
      throw new Error(`Unknown embedding store segment ${seg}`);
    }
    return s;
  }

  codes(seg: number): Int8Array {
    return this.segment(seg).codes;
  }

  scales(seg: number): Float32Array {
    return this.segment(seg).scales;
  }

  touch(): void {
    try {
      const marker = join(this.dir, LAST_USED_FILE);
      const now = new Date();
      try {
        utimesSync(marker, now, now);
      } catch {
        writeFileSync(marker, "");
      }
    } catch {
      // best effort
    }
  }

  close(): void {
    // Mappings are released by GC once views are dropped.
    this.segments.length = 0;
  }
}

export async function openEmbeddingStore(
  scope: StoreScope,
  cacheRoot: string = resolveCacheFolder(),
): Promise<EmbeddingStore> {
  const dir = join(embeddingsRoot(cacheRoot), scopeDirName(scope));
  mkdirSync(dir, { recursive: true });
  if (!existsSync(dir)) {
    throw new Error(`Cannot create embedding store directory ${dir}`);
  }
  return new MappedEmbeddingStore(scope, dir);
}
