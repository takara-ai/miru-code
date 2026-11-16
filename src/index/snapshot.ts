import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { type Chunk, chunkFromDict } from "../types.ts";
import { BM25Index } from "./bm25.ts";
import { withIndexCacheLock } from "./cache-lock.ts";
import { VectorIndex } from "./dense.ts";
import { QuantizedVectorIndex } from "./quantize.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { type SemanticStorage, semanticStorageOf } from "./vector-storage.ts";

const SNAPSHOT_FILE = "snapshot.bin";
const LEGACY_MAGIC = Buffer.from("MIRU_IDX_1\n");
const MAGIC = Buffer.from("MIRU_IDX_2\n");
const TEMPORARY_SNAPSHOT = /^\.snapshot\.bin-[0-9a-f-]{36}$/;
const LEGACY_FILES = new Set(["bm25_index.json", "chunks.json", "metadata.json", "semantic_index"]);
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const READ_BLOCK_BYTES = 64 * 1024 * 1024;
const WINDOWS_RENAME_RETRY_MS = 25;
const WINDOWS_RENAME_TIMEOUT_MS = 5_000;
const WINDOWS_SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface IndexBundle {
  bm25: BM25Index;
  semantic: SemanticIndex;
  chunks: Chunk[];
  metadata: Record<string, unknown>;
}

interface VectorShape {
  storage: SemanticStorage;
  count: number;
  dimensions: number;
}

type AcceptSnapshot = (metadata: Record<string, unknown>, shape: VectorShape) => Promise<boolean>;

async function writeJson(file: FileHandle, value: unknown, compressed = false): Promise<void> {
  const json = JSON.stringify(value);
  const data = compressed ? await compress(json, { level: 1 }) : Buffer.from(json);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.byteLength);
  await file.writeFile(length);
  await file.writeFile(data);
}

async function obsoleteIndexFiles(root: string, hasSnapshot: boolean): Promise<string[]> {
  try {
    const files = await readdir(root);
    return files.filter(
      (file) => TEMPORARY_SNAPSHOT.test(file) || (hasSnapshot && LEGACY_FILES.has(file)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Call with the per-cache writer lock held. Preserve legacy files until publication succeeds. */
export async function cleanIndexFiles(root: string, hasSnapshot: boolean): Promise<void> {
  const paths = await obsoleteIndexFiles(root, hasSnapshot);
  await Promise.all(paths.map((path) => rm(join(root, path), { recursive: true, force: true })));
}

/** A cache hit can reclaim files from a writer that died before completing cleanup. */
export async function cleanAfterCacheHit(root: string, hasSnapshot: boolean): Promise<void> {
  if (!(await obsoleteIndexFiles(root, hasSnapshot)).length) return;
  await withIndexCacheLock(
    root,
    async () => {
      await cleanIndexFiles(root, await Bun.file(join(root, SNAPSHOT_FILE)).exists());
    },
    false,
  );
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function checkChunkCount(chunks: number, bm25: number, vectors: number): void {
  if (bm25 !== chunks || vectors !== chunks) {
    throw new Error("Index snapshot does not have a BM25 entry and vector for every chunk");
  }
}

async function publishSnapshot(
  temporary: string,
  destination: string,
  publish: typeof rename,
): Promise<void> {
  const deadline = performance.now() + WINDOWS_RENAME_TIMEOUT_MS;
  while (true) {
    try {
      await publish(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows may deny replacement until an existing reader closes its handle.
      if (
        process.platform !== "win32" ||
        !code ||
        !WINDOWS_SHARING_ERRORS.has(code) ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      await Bun.sleep(WINDOWS_RENAME_RETRY_MS);
    }
  }
}

/** Publish one complete bundle. A failed write leaves any previous snapshot in place. */
export async function saveIndexSnapshot(
  root: string,
  { bm25, semantic, chunks, metadata }: IndexBundle,
  publish = rename,
): Promise<void> {
  checkChunkCount(chunks.length, bm25.size, semantic.size);
  await mkdir(root, { recursive: true });
  const destination = join(root, SNAPSHOT_FILE);
  const temporary = join(root, `.${SNAPSHOT_FILE}-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      const storage = semanticStorageOf(semantic);
      await file.writeFile(MAGIC);
      await writeJson(file, { storage, count: semantic.size, dimensions: semantic.dimensions });
      await writeJson(file, { ...metadata, vector_storage: storage }, true);
      await writeJson(file, bm25.toJSON(), true);
      await writeJson(file, chunks, true);
      if (semantic instanceof QuantizedVectorIndex) {
        const { codes, scales } = semantic.persistedBuffers();
        await file.writeFile(bytesOf(codes));
        await file.writeFile(bytesOf(scales));
      } else if (semantic instanceof VectorIndex) {
        await file.writeFile(bytesOf(semantic.persistedBuffer()));
      } else {
        throw new Error("Unsupported semantic index type");
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await publishSnapshot(temporary, destination, publish);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function vectorShape(value: unknown): VectorShape {
  const shape = value as VectorShape;
  if (
    !shape ||
    (shape.storage !== "int8" && shape.storage !== "float32") ||
    !Number.isSafeInteger(shape.count) ||
    shape.count < 0 ||
    !Number.isSafeInteger(shape.dimensions) ||
    shape.dimensions < 0
  ) {
    throw new Error("Invalid snapshot vector shape");
  }
  return shape;
}

async function openSnapshot(root: string): Promise<FileHandle | null> {
  try {
    return await open(join(root, SNAPSHOT_FILE), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Keep one descriptor open across validation and load, even if a save replaces the path. */
export async function loadIndexSnapshot(
  root: string,
  accept?: AcceptSnapshot,
): Promise<IndexBundle | null | undefined> {
  const opened = await openSnapshot(root);
  if (!opened) return undefined;
  const file = opened;
  try {
    const { size } = await file.stat();
    let offset = 0;

    function requireBytes(length: number): void {
      if (!Number.isSafeInteger(length) || length > size - offset) {
        throw new Error("Truncated index snapshot");
      }
    }

    async function readInto(bytes: Uint8Array): Promise<void> {
      let filled = 0;
      while (filled < bytes.byteLength) {
        const length = Math.min(bytes.byteLength - filled, READ_BLOCK_BYTES);
        const { bytesRead } = await file.read(bytes, filled, length, offset);
        if (bytesRead === 0) throw new Error("Truncated index snapshot");
        filled += bytesRead;
        offset += bytesRead;
      }
    }

    async function readBytes(length: number): Promise<Buffer> {
      requireBytes(length);
      const bytes = Buffer.allocUnsafe(length);
      await readInto(bytes);
      return bytes;
    }

    async function readFloats(length: number): Promise<Float32Array> {
      requireBytes(length * Float32Array.BYTES_PER_ELEMENT);
      const values = new Float32Array(length);
      await readInto(bytesOf(values));
      return values;
    }

    async function readJson(compressed = false): Promise<unknown> {
      const length = (await readBytes(4)).readUInt32LE();
      const data = await readBytes(length);
      return JSON.parse((compressed ? await decompress(data) : data).toString("utf8"));
    }

    const header = await readBytes(MAGIC.length);
    const compressed = header.equals(MAGIC);
    if (!compressed && !header.equals(LEGACY_MAGIC)) {
      throw new Error("Invalid index snapshot signature");
    }
    const shape = vectorShape(await readJson());
    const metadata = (await readJson(compressed)) as Record<string, unknown>;
    if (accept && !(await accept(metadata, shape))) return null;

    const bm25 = BM25Index.fromJSON(
      (await readJson(compressed)) as Parameters<typeof BM25Index.fromJSON>[0],
    );
    const chunks = ((await readJson(compressed)) as Record<string, unknown>[]).map(chunkFromDict);
    const { count, dimensions, storage } = shape;
    checkChunkCount(chunks.length, bm25.size, count);
    const values = count * dimensions;
    const semantic =
      storage === "int8"
        ? QuantizedVectorIndex.fromPersisted(
            await readBytes(values).then(
              (bytes) => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ),
            await readFloats(count),
            count,
            dimensions,
          )
        : VectorIndex.fromFlatBuffer(await readFloats(values), count, dimensions);
    if (offset !== size) throw new Error("Unexpected trailing bytes in index snapshot");
    return { bm25, semantic, chunks, metadata };
  } finally {
    await file.close();
  }
}
