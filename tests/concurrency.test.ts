import { describe, expect, test } from "bun:test";
import { mapPool, resolveWorkerConcurrency } from "../src/concurrency.ts";

/** Reference impl for A/B regression: shared integer counter instead of iterator. */
const mapPoolCounter = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let i = nextIndex++; i < items.length; i = nextIndex++) {
        results[i] = await worker(items[i] as T, i);
      }
    }),
  );

  return results;
};

const variants = {
  counter: mapPoolCounter,
  iterator: mapPool,
} as const;

describe("concurrency", () => {
  test("resolveWorkerConcurrency is at least 1", () => {
    expect(resolveWorkerConcurrency()).toBeGreaterThanOrEqual(1);
  });

  test("honors validated concurrency overrides and falls back for invalid values", () => {
    const previous = [process.env.MIRU_CONCURRENCY, process.env.MIRU_WORKERS];
    try {
      process.env.MIRU_CONCURRENCY = "3.8";
      process.env.MIRU_WORKERS = "7";
      expect(resolveWorkerConcurrency()).toBe(3);
      process.env.MIRU_CONCURRENCY = "invalid";
      expect(resolveWorkerConcurrency()).toBeGreaterThanOrEqual(1);
      delete process.env.MIRU_CONCURRENCY;
      expect(resolveWorkerConcurrency()).toBe(7);
      process.env.MIRU_WORKERS = "0";
      expect(resolveWorkerConcurrency()).toBeGreaterThanOrEqual(1);
    } finally {
      if (previous[0] === undefined) delete process.env.MIRU_CONCURRENCY;
      else process.env.MIRU_CONCURRENCY = previous[0];
      if (previous[1] === undefined) delete process.env.MIRU_WORKERS;
      else process.env.MIRU_WORKERS = previous[1];
    }
  });

  for (const [name, run] of Object.entries(variants)) {
    describe(`mapPool A/B (${name})`, () => {
      test("preserves order", async () => {
        const out = await run([1, 2, 3, 4, 5], 2, async (n) => {
          await Bun.sleep(5);
          return n * 2;
        });
        expect(out).toEqual([2, 4, 6, 8, 10]);
      });

      test("returns [] for empty input without invoking worker", async () => {
        let calls = 0;
        const out = await run([], 4, async () => {
          calls++;
          return 1;
        });
        expect(out).toEqual([]);
        expect(calls).toBe(0);
      });

      test("passes the original index to the worker", async () => {
        const out = await run(["a", "b", "c"], 2, async (item, i) => `${i}:${item}`);
        expect(out).toEqual(["0:a", "1:b", "2:c"]);
      });

      test("never runs more than `concurrency` workers at once", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await run(
          Array.from({ length: 20 }, (_, i) => i),
          3,
          async (n) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Bun.sleep(2);
            inFlight--;
            return n;
          },
        );
        expect(maxInFlight).toBeLessThanOrEqual(3);
      });

      test("caps workers at item count when concurrency exceeds length", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const out = await run([1, 2, 3], 100, async (n) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(2);
          inFlight--;
          return n;
        });
        expect(out).toEqual([1, 2, 3]);
        expect(maxInFlight).toBeLessThanOrEqual(3);
      });

      test("runs at least one worker when concurrency < 1", async () => {
        const out = await run([1, 2, 3], 0, async (n) => n + 1);
        expect(out).toEqual([2, 3, 4]);
      });

      test("processes every item exactly once", async () => {
        const seen: number[] = [];
        const out = await run(
          Array.from({ length: 50 }, (_, i) => i),
          8,
          async (n) => {
            seen.push(n);
            return n;
          },
        );
        expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
      });
    });
  }

  test("A/B variants agree on mixed async workloads", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const worker = async (n: number) => {
      await Bun.sleep(n % 3);
      return n * 3;
    };

    const [counterOut, iteratorOut] = await Promise.all([
      mapPoolCounter(items, 4, worker),
      mapPool(items, 4, worker),
    ]);

    expect(iteratorOut).toEqual(counterOut);
  });
});
