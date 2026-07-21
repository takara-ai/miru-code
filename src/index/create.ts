import { relative, resolve } from "node:path";
import { chunkSource } from "../chunking/chunking.ts";
import { ensureParserInit } from "../chunking/grammars.ts";
import { resolveWorkerConcurrency } from "../concurrency.ts";
import {
  appendEmbeddingWindowJobs,
  assignEmbeddingWindowVectors,
  type EmbeddingBackend,
  type EmbeddingWindowJob,
  embedTextsWithBackend,
  poolEmbeddingWindowBuckets,
  resolveEmbeddingBatchSize,
  resolveMaxEmbedChars,
} from "../embeddings/openai.ts";
import { envOptionalInt } from "../env.ts";
import { searchImprovementsEnabled } from "../ranking/features.ts";
import { type Chunk, type ContentType, defaultContentTypes } from "../types.ts";
import { BM25Index } from "./bm25.ts";
import { loadRootEntryChunks } from "./entry-chunks.ts";
import { walkFiles } from "./file-walker.ts";
import { detectLanguage, getExtensions, getFileStatus, readFileText } from "./files.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { addChunkToBm25 } from "./sparse.ts";
import { buildSemanticIndex } from "./vector-storage.ts";

/** Keep enough embed HTTP calls in flight to saturate the serverless endpoint. */
const DEFAULT_PIPELINE_EMBED_INFLIGHT = 16;

/** One knob: same as embedding API batch size unless explicitly overridden. */
function resolvePipelineEmbedBatch(): number {
  return envOptionalInt(["MIRU_PIPELINE_EMBED_BATCH"], 1) ?? resolveEmbeddingBatchSize();
}

function resolvePipelineEmbedInflight(): number {
  return envOptionalInt(["MIRU_PIPELINE_EMBED_INFLIGHT"], 1) ?? DEFAULT_PIPELINE_EMBED_INFLIGHT;
}

function resolveMaxIndexFiles(): number | undefined {
  return envOptionalInt(["MIRU_MAX_INDEX_FILES"], 1);
}

export async function createIndexFromPath(
  path: string,
  embeddings: EmbeddingBackend,
  content: ContentType[] = defaultContentTypes(),
  displayRoot?: string,
): Promise<{ bm25: BM25Index; semantic: SemanticIndex; chunks: Chunk[] }> {
  const profile = process.env.MIRU_PROFILE === "1";
  const started = performance.now();
  let fileProcessMs = 0;
  let embedBackpressureWaitMs = 0;
  let bm25BuildMs = 0;
  let fileEnumerated = 0;
  let fileTasks = 0;
  let emptyFileTasks = 0;
  let fileErrors = 0;

  if (profile && "resetStats" in embeddings && typeof embeddings.resetStats === "function") {
    embeddings.resetStats();
  }

  await ensureParserInit();

  const resolved = resolve(path);
  const root = displayRoot ? resolve(displayRoot) : resolved;
  const extensions = getExtensions(content);
  const fileConcurrency = resolveWorkerConcurrency();
  const embedBatchSize = resolvePipelineEmbedBatch();
  const maxEmbedInflight = resolvePipelineEmbedInflight();
  const maxEmbedChars = resolveMaxEmbedChars();
  const maxIndexFiles = resolveMaxIndexFiles();
  const emittedChunks: Chunk[] = [];
  const windowVectorsByChunk: Float32Array[][] = [];
  const pendingWindows: EmbeddingWindowJob[] = [];
  const embedInFlight = new Set<Promise<void>>();
  const embedPromises: Promise<void>[] = [];
  const bm25 = new BM25Index();
  let emittedApiBatches = 0;
  let bm25Cursor = 0;

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
      return await chunkSource(source, chunkPath, language);
    } catch {
      fileErrors++;
      return [];
    } finally {
      fileProcessMs += performance.now() - t;
    }
  };

  /** Burn idle time tokenizing + building BM25 while embeds are in flight. */
  const progressBm25 = (budgetMs = 8): void => {
    const t0 = performance.now();
    while (bm25Cursor < emittedChunks.length && performance.now() - t0 < budgetMs) {
      const chunk = emittedChunks[bm25Cursor];
      if (!chunk) {
        break;
      }
      const tDoc = performance.now();
      addChunkToBm25(bm25, chunk);
      bm25BuildMs += performance.now() - tDoc;
      bm25Cursor++;
    }
  };

  const enqueueChunks = (chunks: Chunk[]): void => {
    for (const chunk of chunks) {
      const chunkIndex = emittedChunks.length;
      emittedChunks.push(chunk);
      windowVectorsByChunk.push([]);
      appendEmbeddingWindowJobs(pendingWindows, chunkIndex, chunk.content, maxEmbedChars);
    }
  };

  const maybeScheduleEmbed = async (force = false): Promise<void> => {
    while (pendingWindows.length > 0 && (force || pendingWindows.length >= embedBatchSize)) {
      if (embedInFlight.size >= maxEmbedInflight) {
        const waitStart = performance.now();
        // Use backpressure stalls to advance BM25 on the main thread.
        while (embedInFlight.size >= maxEmbedInflight) {
          progressBm25(10);
          await Promise.race([Promise.race(embedInFlight), Bun.sleep(0)]);
        }
        embedBackpressureWaitMs += performance.now() - waitStart;
        continue;
      }

      const take = Math.min(embedBatchSize, pendingWindows.length);
      if (!force && take < embedBatchSize) {
        break;
      }

      const batch = pendingWindows.splice(0, take);
      emittedApiBatches++;
      const promise = (async () => {
        const vectors = await embedTextsWithBackend(
          embeddings,
          batch.map((job) => job.text),
        );
        if (vectors.length !== batch.length) {
          throw new Error(
            `Embedding API returned ${vectors.length} vectors for ${batch.length} inputs`,
          );
        }
        assignEmbeddingWindowVectors(batch, vectors, windowVectorsByChunk);
        // After each batch returns, spend a little time on BM25.
        progressBm25(5);
      })();
      embedPromises.push(promise);
      embedInFlight.add(promise);
      promise.finally(() => {
        embedInFlight.delete(promise);
      });
    }
  };

  const runningFiles = new Set<Promise<void>>();

  const startFileTask = (filePath: string): void => {
    const task = (async () => {
      const chunks = await processFile(filePath);
      // Enqueue as soon as the file is ready (no sequential barrier) so the
      // embed pipeline fills immediately under concurrency.
      enqueueChunks(chunks);
      progressBm25(3);
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
      progressBm25(5);
      await Promise.race(runningFiles);
    }
    fileTasks++;
    startFileTask(filePath);
  }

  while (runningFiles.size > 0) {
    progressBm25(5);
    await Promise.race(runningFiles);
  }

  if (searchImprovementsEnabled()) {
    const entryChunks = await loadRootEntryChunks(resolved, displayRoot ? root : undefined);
    if (entryChunks.length > 0) {
      enqueueChunks(entryChunks);
    }
  }

  const embedsDrainedAt = performance.now();
  await maybeScheduleEmbed(true);
  await Promise.all(embedPromises);
  // Finish any BM25 docs not yet processed during idle gaps.
  while (bm25Cursor < emittedChunks.length) {
    progressBm25(50);
  }
  const embedsDoneAt = performance.now();

  const chunks = emittedChunks;

  if (chunks.length === 0) {
    throw new Error(`No supported files found under ${path}.`);
  }

  const poolStarted = performance.now();
  const vectors = poolEmbeddingWindowBuckets(windowVectorsByChunk);
  const poolMs = performance.now() - poolStarted;

  const semanticStarted = performance.now();
  const semantic = buildSemanticIndex(vectors);
  const semanticMs = performance.now() - semanticStarted;

  if (profile) {
    const finished = performance.now();
    const wall = finished - started;
    const embedStats =
      "getStats" in embeddings && typeof embeddings.getStats === "function"
        ? embeddings.getStats()
        : null;
    const pipelineWallMs = embedsDrainedAt - started;
    const embedDrainMs = embedsDoneAt - embedsDrainedAt;
    console.error(
      JSON.stringify({
        profile: "index_build",
        path: resolved,
        elapsed_ms: wall,
        file_enumerated: fileEnumerated,
        file_tasks: fileTasks,
        empty_or_skipped_files: emptyFileTasks,
        file_errors: fileErrors,
        chunks: chunks.length,
        vectors: vectors.length,
        pipeline: {
          file_concurrency: fileConcurrency,
          embed_batch_size: embedBatchSize,
          embed_inflight: maxEmbedInflight,
          emitted_batches: emittedApiBatches,
          max_embed_chars: maxEmbedChars,
        },
        stage_ms: {
          file_process_total: fileProcessMs,
          embed_backpressure_wait: embedBackpressureWaitMs,
          bm25_build_cpu: bm25BuildMs,
          wall_pipeline: pipelineWallMs,
          wall_embed_drain: embedDrainMs,
          wall_pool_windows: poolMs,
          wall_bm25: 0,
          wall_semantic: semanticMs,
          wall_post: poolMs + semanticMs,
        },
        wall_pct: {
          pipeline_overlap: +((100 * pipelineWallMs) / wall).toFixed(1),
          embed_drain: +((100 * embedDrainMs) / wall).toFixed(1),
          pool_windows: +((100 * poolMs) / wall).toFixed(1),
          bm25: 0,
          semantic: +((100 * semanticMs) / wall).toFixed(1),
        },
        embedding_transport: embedStats,
      }),
    );
  }

  return { bm25, semantic, chunks };
}
