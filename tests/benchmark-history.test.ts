import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAgentBenchmarkSummary } from "../src/benchmark/compare.ts";
import {
  appendBenchmarkQuery,
  type BenchmarkQueryRecord,
  clearBenchmarkHistory,
  loadBenchmarkHistory,
  normalizeBenchmarkRepoKey,
  readBenchmarkRollup,
  recordFromBenchmark,
  resolveBenchmarkHistoryPath,
  rollupBenchmarkQueries,
  runWithBenchmarkHistoryPath,
  toAgentBenchmarkRollup,
} from "../src/benchmark/history.ts";
import type { SearchBenchmarkBlock } from "../src/benchmark/types.ts";
import { resolveMiruStateDir } from "../src/credentials.ts";

function sampleBlock(overrides?: {
  miruTokens?: number;
  grepTokens?: number;
  savingsPct?: number;
  miruOnly?: string[];
}): SearchBenchmarkBlock {
  const miru = overrides?.miruTokens ?? 100;
  const grep = overrides?.grepTokens ?? 400;
  return {
    mode: true,
    token_count_method: "wordpiece",
    tokenizer_json: "/very/long/path/to/tokenizer.json",
    miru: {
      search_tokens: miru,
      workflow_tokens: miru,
      latency_ms: 10,
      top_file: "a.ts",
      top_files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    },
    grep_read: {
      search_tokens: 50,
      read_full_tokens: grep - 50,
      read_window_tokens: 80,
      workflow_full_tokens: grep,
      workflow_window_tokens: 130,
      latency_ms: 20,
      top_file: "a.ts",
      top_files: ["a.ts", "z.ts"],
      pattern: "foo|bar|baz",
      keywords: ["foo", "bar", "baz", "qux"],
    },
    efficiency: {
      token_savings_pct: overrides?.savingsPct ?? 75,
      baseline: "grep_search_plus_read_full",
    },
    accuracy: {
      rank1_match: true,
      top_k_overlap_pct: 100,
      miru_only: overrides?.miruOnly ?? [],
      grep_only: ["z.ts"],
    },
    overhead: {
      parallel_total_ms: 25,
      miru_share_ms: 10,
      grep_share_ms: 20,
    },
  };
}

describe("agent benchmark payloads", () => {
  test("toAgentBenchmarkSummary is much smaller than the full block", () => {
    const block = sampleBlock({ miruOnly: ["only-a.ts", "only-b.ts", "only-c.ts", "only-d.ts"] });
    const summary = toAgentBenchmarkSummary(block);
    expect(summary).toEqual({
      save_pct: 75,
      miru_tok: 100,
      grep_tok: 400,
      saved_tok: 300,
      rank1: true,
      miru_only: ["only-a.ts", "only-b.ts", "only-c.ts"],
    });
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(block).length / 3);
  });

  test("toAgentBenchmarkSummary omits empty miru_only", () => {
    expect(toAgentBenchmarkSummary(sampleBlock()).miru_only).toBeUndefined();
  });

  test("toAgentBenchmarkRollup defaults to totals only", () => {
    const queries = [
      recordFromBenchmark("q1", "/a", sampleBlock()),
      recordFromBenchmark("q2", "/a", sampleBlock({ miruTokens: 50, grepTokens: 150 })),
    ];
    const agent = toAgentBenchmarkRollup(rollupBenchmarkQueries(queries));
    expect(agent).toEqual({
      n: 2,
      saved: 400,
      save_pct: 75,
      miru: 150,
      grep: 550,
    });
    expect(agent.repos).toBeUndefined();
    expect(agent.recent).toBeUndefined();
  });
});

describe("benchmark history rollup", () => {
  test("recordFromBenchmark computes tokens_saved from workflow totals", () => {
    const record = recordFromBenchmark("auth middleware", "/repo", sampleBlock());
    expect(record.s).toBe(300);
    expect(record.p).toBe(75);
    expect(record.q).toBe("auth middleware");
    expect(record.r).toBe("/repo");
  });

  test("rollup sums tokens saved across queries", () => {
    const queries: BenchmarkQueryRecord[] = [
      recordFromBenchmark("q1", "/a", sampleBlock({ miruTokens: 100, grepTokens: 400 })),
      recordFromBenchmark(
        "q2",
        "/a",
        sampleBlock({ miruTokens: 50, grepTokens: 150, savingsPct: 67 }),
      ),
      recordFromBenchmark(
        "q3",
        "/b",
        sampleBlock({ miruTokens: 200, grepTokens: 200, savingsPct: 0 }),
      ),
    ];
    const rollup = rollupBenchmarkQueries(queries);
    expect(rollup.query_count).toBe(3);
    expect(rollup.total_tokens_saved).toBe(300 + 100 + 0);
    expect(rollup.total_miru_workflow_tokens).toBe(350);
    expect(rollup.total_grep_workflow_full_tokens).toBe(750);
    expect(rollup.by_repo).toHaveLength(2);
    expect(rollup.by_repo[0]?.repo).toBe("/a");
    expect(rollup.by_repo[0]?.total_tokens_saved).toBe(400);

    const agent = toAgentBenchmarkRollup(rollup);
    expect(agent.repos).toHaveLength(2);
    expect(agent.repos?.[0]).toEqual({ r: "/a", n: 2, saved: 400, save_pct: 71 });
  });

  test("rollup filters by repo", () => {
    const queries = [
      recordFromBenchmark("q1", "/a", sampleBlock()),
      recordFromBenchmark("q2", "/b", sampleBlock()),
    ];
    const rollup = rollupBenchmarkQueries(queries, { repo: "/b", recentLimit: 5 });
    expect(rollup.query_count).toBe(1);
    expect(rollup.recent_queries[0]?.r).toBe("/b");
  });

  test("appendBenchmarkQuery persists and readBenchmarkRollup loads compact agent shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-hist-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("one", "/repo", sampleBlock()), { path });
    await appendBenchmarkQuery(
      recordFromBenchmark("two", "/repo", sampleBlock({ miruTokens: 10, grepTokens: 110 })),
      { path },
    );

    const history = await loadBenchmarkHistory(path);
    expect(history.queries).toHaveLength(2);

    const totals = await readBenchmarkRollup({ path });
    expect(totals).toEqual({
      n: 2,
      saved: 400,
      save_pct: 75,
      miru: 110,
      grep: 510,
    });

    const withRecent = await readBenchmarkRollup({ path, recentLimit: 1 });
    expect(withRecent.recent).toEqual([{ q: "two", saved: 100, pct: 75 }]);
  });

  test("appendBenchmarkQuery trims to maxQueries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-trim-"));
    const path = join(dir, "benchmark-history.json");
    for (let i = 0; i < 5; i++) {
      await appendBenchmarkQuery(recordFromBenchmark(`q${i}`, "/repo", sampleBlock()), {
        path,
        maxQueries: 3,
      });
    }
    const history = await loadBenchmarkHistory(path);
    expect(history.queries.map((row) => row.q)).toEqual(["q2", "q3", "q4"]);
  });

  test("default history path lives in the global Miru state directory", () => {
    const previous = process.env.MIRU_BENCHMARK_HISTORY_PATH;
    const previousCreds = process.env.MIRU_CREDENTIALS_DIR;
    delete process.env.MIRU_BENCHMARK_HISTORY_PATH;
    process.env.MIRU_CREDENTIALS_DIR = "/tmp/miru-state-test";
    try {
      expect(resolveBenchmarkHistoryPath()).toBe(
        join(resolveMiruStateDir(), "benchmark-history.json"),
      );
      expect(resolveBenchmarkHistoryPath()).toBe("/tmp/miru-state-test/benchmark-history.json");
    } finally {
      if (previous === undefined) {
        delete process.env.MIRU_BENCHMARK_HISTORY_PATH;
      } else {
        process.env.MIRU_BENCHMARK_HISTORY_PATH = previous;
      }
      if (previousCreds === undefined) {
        delete process.env.MIRU_CREDENTIALS_DIR;
      } else {
        process.env.MIRU_CREDENTIALS_DIR = previousCreds;
      }
    }
  });

  test("clearBenchmarkHistory deletes the global report file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-clear-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("q", "/repo", sampleBlock()), { path });
    expect(await Bun.file(path).exists()).toBe(true);

    const first = await clearBenchmarkHistory(path);
    expect(first).toEqual({ cleared: true, path });
    expect(await Bun.file(path).exists()).toBe(false);

    const second = await clearBenchmarkHistory(path);
    expect(second).toEqual({ cleared: false, path });
  });

  test("clearBenchmarkHistory honors async path override used by uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-clear-als-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("q", "/repo", sampleBlock()), { path });

    await runWithBenchmarkHistoryPath(path, async () => {
      const result = await clearBenchmarkHistory();
      expect(result.cleared).toBe(true);
      expect(result.path).toBe(path);
    });
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("normalizeBenchmarkRepoKey strips trailing slashes for local paths", () => {
    const base = normalizeBenchmarkRepoKey("/tmp/miru-repo");
    expect(normalizeBenchmarkRepoKey("/tmp/miru-repo/")).toBe(base);
    expect(normalizeBenchmarkRepoKey("/tmp/miru-repo///")).toBe(base);
  });

  test("rollup filters match trailing-slash and relative variants", () => {
    const repo = normalizeBenchmarkRepoKey("/tmp/miru-filter-repo");
    const queries = [
      recordFromBenchmark("q1", `${repo}/`, sampleBlock()),
      recordFromBenchmark("q2", "/other", sampleBlock()),
    ];
    const rollup = rollupBenchmarkQueries(queries, { repo: `${repo}/` });
    expect(rollup.query_count).toBe(1);
    expect(rollup.recent_queries).toEqual([]);
    expect(queries[0]?.r).toBe(repo);
  });

  test("appendBenchmarkQuery serializes concurrent writers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-race-"));
    const path = join(dir, "benchmark-history.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendBenchmarkQuery(recordFromBenchmark(`q${i}`, "/repo", sampleBlock()), { path }),
      ),
    );
    const history = await loadBenchmarkHistory(path);
    expect(history.queries).toHaveLength(20);
    expect(new Set(history.queries.map((row) => row.q)).size).toBe(20);
  });

  test("corrupt history is rotated aside instead of overwritten silently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-corrupt-"));
    const path = join(dir, "benchmark-history.json");
    await Bun.write(path, "{not-json");
    const loaded = await loadBenchmarkHistory(path);
    expect(loaded.queries).toEqual([]);
    expect(await Bun.file(path).exists()).toBe(false);

    const bakEntries = (await readdir(dir)).filter((name) =>
      name.startsWith("benchmark-history.json.bak."),
    );
    expect(bakEntries).toHaveLength(1);
    const bakName = bakEntries[0];
    expect(bakName).toBeDefined();
    if (bakName === undefined) {
      return;
    }

    await appendBenchmarkQuery(recordFromBenchmark("recovered", "/repo", sampleBlock()), { path });
    const after = await loadBenchmarkHistory(path);
    expect(after.queries).toHaveLength(1);
    expect(await Bun.file(join(dir, bakName)).exists()).toBe(true);
  });

  test("wrong-version history is rotated aside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-ver-"));
    const path = join(dir, "benchmark-history.json");
    await Bun.write(
      path,
      `${JSON.stringify({ version: 999, queries: [{ at: "x", q: "old", r: "/r", m: 1, g: 2, s: 1, p: 50 }] })}\n`,
    );
    const loaded = await loadBenchmarkHistory(path);
    expect(loaded.queries).toEqual([]);
    const bakEntries = (await readdir(dir)).filter((name) =>
      name.startsWith("benchmark-history.json.bak."),
    );
    expect(bakEntries.length).toBe(1);
  });
});
