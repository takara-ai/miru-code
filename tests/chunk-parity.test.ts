import { describe, expect, test } from "bun:test";
import type { ChunkBoundary } from "../src/chunking/lines.ts";
import { chunkStructural } from "../src/chunking/structural.ts";
import { CHUNK_PARITY_FIXTURES } from "./chunk-parity-fixtures.ts";

function overlapRatio(a: ChunkBoundary, b: ChunkBoundary): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

function bestMatchScore(expected: ChunkBoundary[], actual: ChunkBoundary[]): number {
  if (expected.length === 0) {
    return 1;
  }
  let sum = 0;
  for (const e of expected) {
    let best = 0;
    for (const a of actual) {
      best = Math.max(best, overlapRatio(e, a));
    }
    sum += best;
  }
  return sum / expected.length;
}

describe("chunking parity fixtures", () => {
  for (const fixture of CHUNK_PARITY_FIXTURES) {
    test(`${fixture.language} structural chunk overlap stays high`, () => {
      const actual = chunkStructural(fixture.source, fixture.language, fixture.desiredLength) ?? [];
      const score = bestMatchScore(fixture.pythonBoundaries, actual);

      // Guardrail: retain high overlap with Python reference boundaries.
      expect(score).toBeGreaterThan(0.8);
    });
  }
});
