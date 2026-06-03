import { describe, expect, test } from "bun:test";
import { mapPool, resolveCpuCount, resolveWorkerConcurrency } from "../src/concurrency.ts";

describe("concurrency", () => {
  test("resolveWorkerConcurrency is at least 1", () => {
    expect(resolveWorkerConcurrency()).toBeGreaterThanOrEqual(1);
    expect(resolveCpuCount()).toBeGreaterThanOrEqual(1);
  });

  test("mapPool preserves order", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      await Bun.sleep(5);
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });
});
