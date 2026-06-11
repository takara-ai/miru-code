import { relative, resolve } from "node:path";
import { chunkSource } from "../chunking/chunking.ts";
import { resolveWorkerConcurrency } from "../concurrency.ts";
import type { EmbeddingBackend } from "../embeddings/openai.ts";
import { envOptionalInt } from "../env.ts";
import { searchImprovementsEnabled } from "../ranking/features.ts";
import { tokenize } from "../tokens.ts";
import type { Chunk, ContentType } from "../types.ts";
import { BM25Index } from "./bm25.ts";
import { loadRootEntryChunks } from "./entry-chunks.ts";
import { walkFiles } from "./file-walker.ts";
import { detectLanguage, getExtensions, getFileStatus, readFileText } from "./files.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { enrichForBm25 } from "./sparse.ts";
import { buildSemanticIndex } from "./vector-storage.ts";

const DEFAULT_PIPELINE_EMBED_BATCH = 64;
const DEFAULT_PIPELINE_EMBED_INFLIGHT = 8;

function resolvePipelineEmbedBatch(): number {
  return (
    envOptionalInt(["MIRU_PIPELINE_EMBED_BATCH"], 1) ??
    DEFAULT_PIPELINE_EMBED_BATCH
  );
}

function resolvePipelineEmbedInflight(): number {
  return (
    envOptionalInt(["MIRU_PIPELINE_EMBED_INFLIGHT"], 1) ??
    DEFAULT_PIPELINE_EMBED_INFLIGHT
  );
}

function resolveMaxIndexFiles(): number | undefined {
  return envOptionalInt(["MIRU_MAX_INDEX_FILES"], 1);
}

export async function createIndexFromPath(
  path: string,
  embeddings: EmbeddingBackend,
  content: ContentType[] = ["code"],
  displayRoot?: string,
): Promise<{ bm25: BM25Index; semantic: SemanticIndex; chunks: Chunk[] }> {
  const profile = process.env.MIRU_PROFILE === "1";
  const started = performance.now();
  let fileProcessMs = 0;
  let embedBackpressureWaitMs = 0;
  let fileEnumerated = 0;
  let fileTasks = 0;
  let emptyFileTasks = 0;

  if (profile && "resetStats" in embeddings && typeof embeddings.resetStats === "function") {
    embeddings.resetStats();
  }

  const resolved = resolve(path);
  const root = displayRoot ? resolve(displayRoot) : resolved;
  const extensions = getExtensions(content);
  const fileConcurrency = resolveWorkerConcurrency();
  const embedBatchSize = resolvePipelineEmbedBatch();
  const maxEmbedInflight = resolvePipelineEmbedInflight();
  const maxIndexFiles = resolveMaxIndexFiles();
  const readyBySeq = new Map<number, Chunk[]>();
  const pendingEmbedChunks: Chunk[] = [];
  const emittedChunkBatches: Chunk[][] = [];
  const embedInFlight = new Set<Promise<Float32Array[]>>();
  const embedPromises: Promise<Float32Array[]>[] = [];
  let fileSeq = 0;
  let nextEmitSeq = 0;

  const processFile = async (filePath: string): Promise<Chunk[]> => {
    const t = performance.now();
    const language = detectLanguage(filePath);
    try {
      const status = await getFileStatus(filePath);
      if (status !== "valid") {
        emptyFileTasks++;
        return [] as Chunk[];
      }
      const source = await readFileText(filePath);
      const chunkPath = displayRoot ? relative(root, filePath).replace(/\\/g, "/") : filePath;
      return chunkSource(source, chunkPath, language);
    } catch {
      emptyFileTasks++;
      return [];
    } finally {
      fileProcessMs += performance.now() - t;
    }
  };

  const flushReadySequentialChunks = (): void => {
    while (readyBySeq.has(nextEmitSeq)) {
      const chunks = readyBySeq.get(nextEmitSeq);
      readyBySeq.delete(nextEmitSeq);
      if (chunks) {
        pendingEmbedChunks.push(...chunks);
      }
      nextEmitSeq++;
    }
  };

  const maybeScheduleEmbed = async (force = false): Promise<void> => {
    while (
      pendingEmbedChunks.length > 0 &&
      (force || pendingEmbedChunks.length >= embedBatchSize)
    ) {
      if (embedInFlight.size >= maxEmbedInflight) {
        const waitStart = performance.now();
        await Promise.race(embedInFlight);
        embedBackpressureWaitMs += performance.now() - waitStart;
        continue;
      }

      const take = force
        ? pendingEmbedChunks.length
        : Math.min(embedBatchSize, pendingEmbedChunks.length);
      const batch = pendingEmbedChunks.splice(0, take);
      emittedChunkBatches.push(batch);
      const promise = embeddings.embedDocuments(batch.map((chunk) => chunk.content));
      embedPromises.push(promise);
      embedInFlight.add(promise);
      promise.finally(() => {
        embedInFlight.delete(promise);
      });
    }
  };

  const runningFiles = new Set<Promise<void>>();

  const startFileTask = (filePath: string, seq: number): void => {
    const task = (async () => {
      const chunks = await processFile(filePath);
      readyBySeq.set(seq, chunks);
      flushReadySequentialChunks();
      await maybeScheduleEmbed(false);
    })().finally(() => {
      runningFiles.delete(task);
    });
    runningFiles.add(task);
  };

  for await (const filePath of walkFiles(resolved, extensions)) {
    fileEnumerated++;
    if (maxIndexFiles != null && fileEnumerated > maxIndexFiles) {
      throw new Error(`Index file budget exceeded: max ${maxIndexFiles} files per operation`);
    }
    while (runningFiles.size >= fileConcurrency) {
      await Promise.race(runningFiles);
    }
    fileTasks++;
    startFileTask(filePath, fileSeq++);
  }

  while (runningFiles.size > 0) {
    await Promise.race(runningFiles);
  }

  if (searchImprovementsEnabled()) {
    const entryChunks = await loadRootEntryChunks(resolved, displayRoot ? root : undefined);
    if (entryChunks.length > 0) {
      readyBySeq.set(fileSeq++, entryChunks);
      flushReadySequentialChunks();
    }
  }

  flushReadySequentialChunks();
  await maybeScheduleEmbed(true);
  await Promise.all(embedPromises);

  const chunks = emittedChunkBatches.flat();

  if (chunks.length === 0) {
    throw new Error(`No supported files found under ${path}.`);
  }

  const vectors = (await Promise.all(embedPromises)).flat();
  const bm25 = new BM25Index();
  bm25.index(chunks.map((c) => tokenize(enrichForBm25(c))));
  const semantic = buildSemanticIndex(vectors);

  if (profile) {
    const finished = performance.now();
    const embedStats =
      "getStats" in embeddings && typeof embeddings.getStats === "function"
        ? embeddings.getStats()
        : null;
    console.error(
      JSON.stringify({
        profile: "index_build",
        path: resolved,
        elapsed_ms: finished - started,
        file_enumerated: fileEnumerated,
        file_tasks: fileTasks,
        empty_or_skipped_files: emptyFileTasks,
        chunks: chunks.length,
        vectors: vectors.length,
        pipeline: {
          file_concurrency: fileConcurrency,
          embed_batch_size: embedBatchSize,
          embed_inflight: maxEmbedInflight,
          emitted_batches: emittedChunkBatches.length,
        },
        stage_ms: {
          file_process_total: fileProcessMs,
          embed_backpressure_wait: embedBackpressureWaitMs,
        },
        embedding_transport: embedStats,
      }),
    );
  }

  return { bm25, semantic, chunks };
}
