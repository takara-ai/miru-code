/** Size-capped LRU pruning and small-segment compaction for embedding stores. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  compareHash,
  embeddingsRoot,
  LAST_USED_FILE,
  listSegmentIds,
  segmentPaths,
  writeSegment,
} from "./embedding-store.ts";
import { HASH_BYTES } from "./embedding-store-types.ts";

const DEFAULT_MAX_MB = 2048;
const COMPACT_MIN_SEGMENTS = 9;
const SMALL_SEGMENT_BYTES = 8 * 1024 * 1024;

export interface GcOptions {
  cacheRoot?: string;
  maxBytes?: number;
}

export interface GcResult {
  removedSegments: number;
  freedBytes: number;
}

function defaultMaxBytes(): number {
  const raw = Number(process.env.MIRU_EMBED_CACHE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function segmentBytes(dir: string, id: string): number {
  const p = segmentPaths(dir, id);
  return fileSize(p.hashes) + fileSize(p.codes) + fileSize(p.scales);
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Unlink a segment hashes-first so readers never see a half segment. Returns true if the hashes file is gone. */
async function removeSegment(dir: string, id: string): Promise<boolean> {
  const p = segmentPaths(dir, id);
  try {
    await unlink(p.hashes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return false;
    }
  }
  for (const f of [p.codes, p.scales]) {
    try {
      await unlink(f);
    } catch {
      // swallowed (e.g. mapped on Windows)
    }
  }
  return true;
}

/** Merge many small segments of one store into a single segment. Returns segments merged. */
export async function compactEmbeddingStore(scopeDir: string): Promise<number> {
  const small = listSegmentIds(scopeDir).filter(
    (id) => segmentBytes(scopeDir, id) < SMALL_SEGMENT_BYTES,
  );
  if (small.length < COMPACT_MIN_SEGMENTS) {
    return 0;
  }

  interface Loaded {
    id: string;
    n: number;
    dim: number;
    hashes: Uint8Array;
    codes: Uint8Array;
    scales: Uint8Array;
  }
  const loaded: Loaded[] = [];
  let dim = 0;
  for (const id of small) {
    try {
      const p = segmentPaths(scopeDir, id);
      const hashes = new Uint8Array(readFileSync(p.hashes));
      const codes = new Uint8Array(readFileSync(p.codes));
      const scales = new Uint8Array(readFileSync(p.scales));
      const n = hashes.byteLength / HASH_BYTES;
      if (!Number.isInteger(n) || n === 0 || scales.byteLength !== n * 4) {
        continue;
      }
      const segDim = codes.byteLength / n;
      if (!Number.isInteger(segDim) || (dim !== 0 && segDim !== dim)) {
        continue;
      }
      dim = segDim;
      loaded.push({ id, n, dim: segDim, hashes, codes, scales });
    } catch {
      // skip unreadable segment
    }
  }
  if (loaded.length < COMPACT_MIN_SEGMENTS) {
    return 0;
  }

  // Newest segment wins on duplicates: iterate newest-first, keep first sighting.
  const rows: Array<{ seg: Loaded; row: number }> = [];
  for (let s = loaded.length - 1; s >= 0; s--) {
    const seg = loaded[s] as Loaded;
    for (let r = 0; r < seg.n; r++) {
      rows.push({ seg, row: r });
    }
  }
  rows.sort(
    (a, b) => compareHash(a.seg.hashes, a.row * HASH_BYTES, b.seg.hashes, b.row * HASH_BYTES) || 0,
  );
  const kept: typeof rows = [];
  for (const item of rows) {
    const prev = kept[kept.length - 1];
    if (
      prev &&
      compareHash(
        prev.seg.hashes,
        prev.row * HASH_BYTES,
        item.seg.hashes,
        item.row * HASH_BYTES,
      ) === 0
    ) {
      continue;
    }
    kept.push(item);
  }

  const hashes = new Uint8Array(kept.length * HASH_BYTES);
  const codes = new Int8Array(kept.length * dim);
  const scalesBytes = new Uint8Array(kept.length * 4);
  kept.forEach(({ seg, row }, i) => {
    hashes.set(seg.hashes.subarray(row * HASH_BYTES, (row + 1) * HASH_BYTES), i * HASH_BYTES);
    codes.set(new Int8Array(seg.codes.buffer, seg.codes.byteOffset + row * dim, dim), i * dim);
    scalesBytes.set(seg.scales.subarray(row * 4, row * 4 + 4), i * 4);
  });
  const scales = new Float32Array(scalesBytes.buffer, 0, kept.length);

  await writeSegment(scopeDir, hashes, codes, scales);
  for (const seg of loaded) {
    await removeSegment(scopeDir, seg.id);
  }
  return loaded.length;
}

export async function gcEmbeddingStores(options: GcOptions = {}): Promise<GcResult> {
  const root = embeddingsRoot(options.cacheRoot);
  const maxBytes = options.maxBytes ?? defaultMaxBytes();
  let removedSegments = 0;
  let freedBytes = 0;

  let scopeDirs: string[];
  try {
    scopeDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return { removedSegments, freedBytes };
  }

  for (const dir of scopeDirs) {
    try {
      const before = listSegmentIds(dir).reduce((sum, id) => sum + segmentBytes(dir, id), 0);
      await compactEmbeddingStore(dir);
      const after = listSegmentIds(dir).reduce((sum, id) => sum + segmentBytes(dir, id), 0);
      if (before > after) {
        freedBytes += before - after;
      }
    } catch {
      // best effort
    }
  }

  interface Candidate {
    dir: string;
    id: string;
    bytes: number;
    storeUsed: number;
    mtime: number;
  }
  const candidates: Candidate[] = [];
  let total = 0;
  for (const dir of scopeDirs) {
    const storeUsed = mtimeMs(join(dir, LAST_USED_FILE)) || mtimeMs(dir);
    for (const id of listSegmentIds(dir)) {
      const bytes = segmentBytes(dir, id);
      total += bytes;
      candidates.push({
        dir,
        id,
        bytes,
        storeUsed,
        mtime: mtimeMs(segmentPaths(dir, id).hashes),
      });
    }
  }

  candidates.sort((a, b) => a.storeUsed - b.storeUsed || a.mtime - b.mtime);
  for (const c of candidates) {
    if (total <= maxBytes) {
      break;
    }
    if (await removeSegment(c.dir, c.id)) {
      total -= c.bytes;
      freedBytes += c.bytes;
      removedSegments++;
    }
  }
  return { removedSegments, freedBytes };
}
