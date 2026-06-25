/**
 * Concurrency helpers for indexing and embedding pipelines.
 *
 * Caps parallel file parsing, BM25 scoring, and embed batching so Miru stays
 * responsive on laptops and shared CI runners without starving the OS.
 */
import { availableParallelism } from "node:os";

/** Cores left for the event loop, MCP stdio, and other host processes during indexing. */
export const DEFAULT_RESERVE_CORES = 2;

function workerCount(concurrency: number, itemCount: number): number {
  return Math.max(1, Math.min(concurrency, itemCount));
}

/**
 * Worker pool size for file parsing and other CPU-bound index work.
 *
 * Default: `availableParallelism() - DEFAULT_RESERVE_CORES`, floored at 1.
 * Override with `MIRU_CONCURRENCY` or legacy alias `MIRU_WORKERS`.
 * Invalid env values are ignored so a typo does not crash indexing.
 */
export function resolveWorkerConcurrency(): number {
  const raw = process.env.MIRU_CONCURRENCY ?? process.env.MIRU_WORKERS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) {
      return Math.floor(n);
    }
  }
  return Math.max(1, availableParallelism() - DEFAULT_RESERVE_CORES);
}

/**
 * Bounded parallel map: at most `concurrency` workers run `worker` at once.
 *
 * Unlike `Promise.all(items.map(worker))`, this limits in-flight tasks when
 * `items` is large (e.g. thousands of source files). Output order matches
 * input order because each result is stored at its original index.
 *
 * Workers share a single `items.entries()` iterator; each claims the next
 * `[index, item]` pair until the input is exhausted.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const pending = items.entries();

  await Promise.all(
    Array.from({ length: workerCount(concurrency, items.length) }, async () => {
      for (const [i, item] of pending) {
        results[i] = await worker(item, i);
      }
    }),
  );

  return results;
}
