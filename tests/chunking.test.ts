import { describe, expect, test } from "bun:test";
import { chunkSource } from "../src/chunking/chunking.ts";
import { chunkStructural } from "../src/chunking/structural.ts";
import { CHUNK_PARITY_FIXTURES } from "./chunk-parity-fixtures.ts";

describe("chunkStructural", () => {
  for (const fixture of CHUNK_PARITY_FIXTURES) {
    test(`${fixture.language} parity fixture yields multiple structural chunks`, () => {
      const boundaries =
        chunkStructural(fixture.source, fixture.language, fixture.desiredLength) ?? [];
      expect(boundaries.length).toBeGreaterThanOrEqual(2);

      const slices = boundaries.map(({ start, end }) => fixture.source.slice(start, end));
      expect(new Set(slices.map((s) => s.trim())).size).toBe(slices.length);
    });
  }
});

describe("chunkSource", () => {
  test("preserves valid line numbers and non-empty content", async () => {
    const fixture = CHUNK_PARITY_FIXTURES[0];
    if (!fixture) {
      throw new Error("Missing python parity fixture");
    }
    const chunks = await chunkSource(fixture.source, "service.py", fixture.language);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.start_line).toBeGreaterThan(0);
      expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
      expect(chunk.content.trim().length).toBeGreaterThan(0);
      expect(chunk.file_path).toBe("service.py");
      expect(fixture.source).toContain(chunk.content.trim().slice(0, 40));
    }
  });

  test("splits very large sources into multiple chunks", async () => {
    const fixture = CHUNK_PARITY_FIXTURES[0];
    if (!fixture) {
      throw new Error("Missing python parity fixture");
    }
    const largeSource = Array.from({ length: 4 }, () => fixture.source).join("\n\n");
    const chunks = await chunkSource(largeSource, "large.py", fixture.language);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
