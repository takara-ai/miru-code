import { availableParallelism, cpus } from "node:os";

const DEFAULT_RESERVE_CORES = 2;

export function resolveCpuCount(): number {
  if (typeof availableParallelism === "function") {
    return availableParallelism();
  }
  return cpus().length;
}

/** Worker pool size: logical CPUs minus 2, minimum 1. Override with MIRU_CONCURRENCY. */
export function resolveWorkerConcurrency(): number {
  const raw = process.env.MIRU_CONCURRENCY ?? process.env.MIRU_WORKERS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) {
      return Math.floor(n);
    }
  }
  return Math.max(1, resolveCpuCount() - DEFAULT_RESERVE_CORES);
}

/** Run async work over items with at most `concurrency` tasks in flight. Results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function drain(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) {
        return;
      }
      const item = items[i];
      if (item === undefined) {
        continue;
      }
      results[i] = await worker(item, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => drain()));
  return results;
}
