import { describe, expect, test } from "bun:test";
import { BM25Index } from "../src/index/bm25.ts";

describe("BM25Index", () => {
  test("ranks matching document higher than unrelated document", () => {
    const index = new BM25Index();
    index.index([
      ["auth", "middleware", "token"],
      ["database", "migration", "schema"],
    ]);
    const scores = index.getScores(["auth", "token"]);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });

  test("ranks document with more query terms higher", () => {
    const index = new BM25Index();
    index.index([["alpha"], ["alpha", "beta", "gamma"], ["delta", "epsilon"]]);
    const scores = index.getScores(["alpha", "beta"]);
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 0);
  });

  test("returns zero scores for unknown query terms", () => {
    const index = new BM25Index();
    index.index([["known", "term"]]);
    const scores = index.getScores(["missing", "terms"]);
    expect(scores.every((s) => s === 0)).toBe(true);
  });

  test("respects weight mask", () => {
    const index = new BM25Index();
    index.index([
      ["auth", "token"],
      ["auth", "token", "extra"],
    ]);
    const masked = index.getScores(["auth"], [false, true]);
    expect(masked[0]).toBe(0);
    expect(masked[1]).toBeGreaterThan(0);
  });

  test("getScoresAsync matches getScores", async () => {
    const docs: string[][] = [];
    for (let d = 0; d < 300; d++) {
      docs.push(
        d % 2 === 0 ? ["alpha", "beta", "gamma", `doc${d}`] : ["delta", "epsilon", `other${d}`],
      );
    }
    const index = new BM25Index();
    index.index(docs);
    const query = ["alpha", "doc42", "epsilon"];
    expect(await index.getScoresAsync(query)).toEqual(index.getScores(query));
  });
});
