import { afterEach, describe, expect, test } from "bun:test";
import { applyQueryBoost, boostMultiChunkFiles, isSymbolQuery } from "../src/ranking/boosting.ts";
import type { Chunk } from "../src/types.ts";
import { chunkKey } from "../src/types.ts";

function chunk(file_path: string, content: string, start_line = 1): Chunk {
  return { file_path, content, start_line, end_line: start_line + 5, language: "typescript" };
}

const originals = new Map(
  ["MIRU_SEARCH_V2", "MIRU_RANK_FILE_COHERENCE_BOOST"].map((key) => [key, process.env[key]]),
);
afterEach(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ranking boosts", () => {
  test("recognizes symbol query forms and preserves empty score maps", () => {
    expect(isSymbolQuery("Foo::bar")).toBe(true);
    expect(isSymbolQuery("snake_case")).toBe(true);
    expect(isSymbolQuery("how does search work?")).toBe(false);
    const scores = new Map<string, number>();
    expect(applyQueryBoost(scores, "search", [], new Map())).toBe(scores);
    expect(boostMultiChunkFiles(scores, new Map())).toBeUndefined();
  });

  test("boosts symbol definitions in scored chunks and discovers matching file chunks", () => {
    const definition = chunk("src/HTTPClient.ts", "export class HTTPClient {}", 3);
    const unrelated = chunk("src/other.ts", "export function other() {}", 20);
    const undiscovered = chunk("src/README.md", "architecture notes", 30);
    const scores = new Map([[chunkKey(unrelated), 2]]);
    const byKey = new Map([
      [chunkKey(definition), definition],
      [chunkKey(unrelated), unrelated],
      [chunkKey(undiscovered), undiscovered],
    ]);
    applyQueryBoost(scores, "HTTPClient", [definition, unrelated, undiscovered], byKey);
    expect(scores.get(chunkKey(definition))).toBeGreaterThan(0);

    const namespaced = chunk("src/client.ts", "CREATE TABLE Client (id INT)");
    const sqlScores = new Map([[chunkKey(namespaced), 1]]);
    applyQueryBoost(
      sqlScores,
      "db.Client",
      [namespaced],
      new Map([[chunkKey(namespaced), namespaced]]),
    );
    expect(sqlScores.get(chunkKey(namespaced))).toBeGreaterThan(1);
  });

  test("boosts embedded symbol matches and file stem tokens", () => {
    process.env.MIRU_SEARCH_V2 = "0";
    const direct = chunk("src/http_client.ts", "export function parseHTTPResponse() {}");
    const parent = chunk("src/search/index.ts", "search behavior");
    const discovered = chunk("src/parseHTTPRes.ts", "export function parseHTTPResponse() {}");
    const scores = new Map([
      [chunkKey(direct), 1],
      [chunkKey(parent), 1],
    ]);
    const byKey = new Map([
      [chunkKey(direct), direct],
      [chunkKey(parent), parent],
    ]);
    applyQueryBoost(
      scores,
      "find parseHTTPResponse in search implementation",
      [direct, parent, discovered, chunk("src/README.md", "unrelated documentation")],
      byKey,
    );
    expect(scores.get(chunkKey(direct))).toBeGreaterThan(1);
    expect(scores.get(chunkKey(parent))).toBeGreaterThan(1);
    expect(scores.get(chunkKey(discovered))).toBeGreaterThan(0);

    const emptyKeywords = new Map([[chunkKey(parent), 1]]);
    applyQueryBoost(emptyKeywords, "is it", [parent], byKey);
    expect(emptyKeywords.get(chunkKey(parent))).toBe(1);

    const exact = chunk("src/search.ts", "search implementation");
    const exactScores = new Map([[chunkKey(exact), 1]]);
    applyQueryBoost(exactScores, "search", [exact], new Map([[chunkKey(exact), exact]]));
    expect(exactScores.get(chunkKey(exact))).toBeGreaterThan(1);

    const noWords = new Map([[chunkKey(exact), 1]]);
    applyQueryBoost(noWords, "???", [exact], new Map([[chunkKey(exact), exact]]));
    expect(noWords.get(chunkKey(exact))).toBe(1);
  });

  test("coheres scores by file, skips missing chunks and zero maxima", () => {
    process.env.MIRU_RANK_FILE_COHERENCE_BOOST = "0.5";
    const a = chunk("src/shared.ts", "function a() {}");
    const b = chunk("src/shared.ts", "function b() {}", 10);
    const scores = new Map([
      [chunkKey(a), 2],
      [chunkKey(b), 1],
      ["missing", 3],
    ]);
    const byKey = new Map([
      [chunkKey(a), a],
      [chunkKey(b), b],
    ]);
    boostMultiChunkFiles(scores, byKey);
    expect(scores.get(chunkKey(a))).toBeGreaterThan(2);

    const zeros = new Map([[chunkKey(a), 0]]);
    boostMultiChunkFiles(zeros, byKey);
    expect(zeros.get(chunkKey(a))).toBe(0);
  });
});
