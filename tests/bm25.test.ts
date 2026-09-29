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

  test("terminates workers and rejects when a worker fails", async () => {
    const previousWorker = globalThis.Worker;
    const previousConcurrency = process.env.MIRU_CONCURRENCY;
    class FailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      postMessage() {
        queueMicrotask(() => this.onerror?.(new Error("worker failed") as unknown as ErrorEvent));
      }
      terminate() {
        this.terminated = true;
      }
    }
    const workers: FailingWorker[] = [];
    globalThis.Worker = class extends FailingWorker {
      constructor(..._args: ConstructorParameters<typeof Worker>) {
        super();
        workers.push(this);
      }
    } as unknown as typeof Worker;
    process.env.MIRU_CONCURRENCY = "2";
    try {
      const index = new BM25Index();
      index.index(Array.from({ length: 300 }, () => ["alpha"]));
      await expect(index.getScoresAsync(["alpha"])).rejects.toThrow("worker failed");
      expect(workers.length).toBe(2);
      expect(workers.every((worker) => worker.terminated)).toBe(true);
    } finally {
      globalThis.Worker = previousWorker;
      if (previousConcurrency === undefined) delete process.env.MIRU_CONCURRENCY;
      else process.env.MIRU_CONCURRENCY = previousConcurrency;
    }
  });

  test("terminates successful workers after their result arrives", async () => {
    const previousWorker = globalThis.Worker;
    const previousConcurrency = process.env.MIRU_CONCURRENCY;
    class SuccessfulWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      postMessage(job: { startDoc: number; endDoc: number }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              startDoc: job.startDoc,
              scores: new Array(job.endDoc - job.startDoc).fill(1),
            },
          } as MessageEvent),
        );
      }
      terminate() {
        this.terminated = true;
      }
    }
    const workers: SuccessfulWorker[] = [];
    globalThis.Worker = class extends SuccessfulWorker {
      constructor(..._args: ConstructorParameters<typeof Worker>) {
        super();
        workers.push(this);
      }
    } as unknown as typeof Worker;
    process.env.MIRU_CONCURRENCY = "2";
    try {
      const index = new BM25Index();
      index.index(Array.from({ length: 300 }, () => ["alpha"]));
      expect(await index.getScoresAsync(["alpha"])).toEqual(new Array(300).fill(1));
      expect(workers).toHaveLength(2);
      expect(workers.every((worker) => worker.terminated)).toBe(true);
    } finally {
      globalThis.Worker = previousWorker;
      if (previousConcurrency === undefined) delete process.env.MIRU_CONCURRENCY;
      else process.env.MIRU_CONCURRENCY = previousConcurrency;
    }
  });
});
