import { describe, expect, test } from "bun:test";
import {
  selectTopKByDistance,
  TopKDistanceCollector,
  type TopKDistanceEntry,
} from "../src/index/topk.ts";
import { seededRandom } from "./test-helpers.ts";

function buildEntries(count: number): TopKDistanceEntry[] {
  const rand = seededRandom(42);
  return Array.from({ length: count }, (_, index) => ({
    index,
    distance: rand(),
  }));
}

describe("TopKDistanceCollector A/B", () => {
  test("matches legacy selectTopKByDistance", () => {
    const entries = buildEntries(5_000);
    const k = 50;
    const legacy = selectTopKByDistance(entries, k);

    const collector = new TopKDistanceCollector(k);
    for (const entry of entries) {
      collector.offer(entry.index, entry.distance);
    }
    const optimized = collector.finish();

    expect(optimized).toEqual(legacy);
  });
});
