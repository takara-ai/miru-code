import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAgentBenchmarkSummary } from "../src/benchmark/compare.ts";
import {
  appendBenchmarkQuery,
  type BenchmarkContribution,
  clearBenchmarkHistory,
  loadBenchmarkHistory,
  normalizeBenchmarkRepoKey,
  readBenchmarkRollup,
  recordFromBenchmark,
  resolveBenchmarkHistoryPath,
  runWithBenchmarkHistoryPath,
} from "../src/benchmark/history.ts";
import type { SearchBenchmarkBlock } from "../src/benchmark/types.ts";
import { resolveMiruStateDir } from "../src/credentials.ts";

function block(overrides?: {
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
    const full = block({ miruOnly: ["only-a.ts", "only-b.ts", "only-c.ts", "only-d.ts"] });
    const summary = toAgentBenchmarkSummary(full);
    expect(summary).toEqual({
      save_pct: 75,
      miru_tok: 100,
      grep_tok: 400,
      saved_tok: 300,
      rank1: true,
      miru_only: ["only-a.ts", "only-b.ts", "only-c.ts"],
    });
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 3);
  });

  test("toAgentBenchmarkSummary omits empty miru_only", () => {
    expect(toAgentBenchmarkSummary(block()).miru_only).toBeUndefined();
  });

  test("toAgentBenchmarkRollup defaults to totals only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-agent-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("/a", block()), { path });
    await appendBenchmarkQuery(
      recordFromBenchmark("/a", block({ miruTokens: 50, grepTokens: 150 })),
      { path },
    );
    const agent = await readBenchmarkRollup({ path });
    expect(agent).toEqual({
      n: 2,
      saved: 400,
      save_pct: 75,
      miru: 150,
      grep: 550,
    });
    expect(agent.repos).toBeUndefined();
  });
});

describe("benchmark history aggregates", () => {
  test("recordFromBenchmark omits query text and stores repo + token totals", () => {
    const repo = normalizeBenchmarkRepoKey("/repo");
    const record = recordFromBenchmark("/repo", block());
    expect(record).toEqual({
      r: repo,
      m: 100,
      g: 400,
      s: 300,
      p: 75,
    });
    expect("q" in record).toBe(false);
  });

  test("append folds contributions into running totals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-hist-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path });
    await appendBenchmarkQuery(
      recordFromBenchmark("/repo", block({ miruTokens: 10, grepTokens: 110 })),
      { path },
    );

    const history = await loadBenchmarkHistory(path);
    expect(history.n).toBe(2);
    expect(history.miru).toBe(110);
    expect(history.grep).toBe(510);
    expect(history.saved).toBe(400);
    expect(Object.keys(history.repos)).toEqual([normalizeBenchmarkRepoKey("/repo")]);

    const totals = await readBenchmarkRollup({ path });
    expect(totals).toEqual({
      n: 2,
      saved: 400,
      save_pct: 75,
      miru: 110,
      grep: 510,
    });
  });

  test("rollup filters by repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-filter-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("/a", block()), { path });
    await appendBenchmarkQuery(recordFromBenchmark("/b", block()), { path });

    const all = await readBenchmarkRollup({ path });
    expect(all.n).toBe(2);
    expect(all.repos).toHaveLength(2);

    const onlyB = await readBenchmarkRollup({ path, repo: "/b" });
    expect(onlyB).toEqual({
      n: 1,
      saved: 300,
      save_pct: 75,
      miru: 100,
      grep: 400,
    });
    expect(onlyB.repos).toBeUndefined();
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
      expect(resolveBenchmarkHistoryPath()).toBe(
        join("/tmp", "miru-state-test", "benchmark-history.json"),
      );
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
    await appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path });
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
    await appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path });

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

  test("rollup filters match trailing-slash variants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-slash-"));
    const path = join(dir, "benchmark-history.json");
    const repo = normalizeBenchmarkRepoKey("/tmp/miru-filter-repo");
    await appendBenchmarkQuery(recordFromBenchmark(`${repo}/`, block()), { path });
    await appendBenchmarkQuery(recordFromBenchmark("/other", block()), { path });

    const rollup = await readBenchmarkRollup({ path, repo: `${repo}/` });
    expect(rollup.n).toBe(1);
    expect(rollup.saved).toBe(300);
  });

  test("appendBenchmarkQuery serializes concurrent writers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-race-"));
    const path = join(dir, "benchmark-history.json");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path }),
      ),
    );
    const history = await loadBenchmarkHistory(path);
    expect(history.n).toBe(20);
    expect(history.miru).toBe(20 * 100);
    expect(history.grep).toBe(20 * 400);
    expect(history.saved).toBe(20 * 300);
  });

  test("cross-process appends keep both contributions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-xproc-"));
    const path = join(dir, "benchmark-history.json");
    await appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path });

    const recA: BenchmarkContribution = recordFromBenchmark("/a", block());
    const recB: BenchmarkContribution = recordFromBenchmark("/b", block());
    const historyModule = join(import.meta.dir, "../src/benchmark/history.ts");

    const run = (record: BenchmarkContribution, label: string) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `
import { appendBenchmarkQuery } from ${JSON.stringify(historyModule)};
console.error(${JSON.stringify(label)});
await appendBenchmarkQuery(${JSON.stringify(record)}, { path: ${JSON.stringify(path)} });
`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

    const pA = run(recA, "A");
    const pB = run(recB, "B");
    const [codeA, codeB] = await Promise.all([pA.exited, pB.exited]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    const history = await loadBenchmarkHistory(path);
    expect(history.n).toBe(3);
    expect(Object.keys(history.repos).sort()).toEqual(
      ["/a", "/b", normalizeBenchmarkRepoKey("/repo")].map(normalizeBenchmarkRepoKey).sort(),
    );
  });

  test("corrupt history is rotated aside instead of overwritten silently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-corrupt-"));
    const path = join(dir, "benchmark-history.json");
    await Bun.write(path, "{not-json");
    const loaded = await loadBenchmarkHistory(path);
    expect(loaded.n).toBe(0);
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

    await appendBenchmarkQuery(recordFromBenchmark("/repo", block()), { path });
    const after = await loadBenchmarkHistory(path);
    expect(after.n).toBe(1);
    expect(await Bun.file(join(dir, bakName)).exists()).toBe(true);
  });

  test("unreadable history is rotated aside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miru-bench-ver-"));
    const path = join(dir, "benchmark-history.json");
    // Old aggregate object (or any non-contribution JSON) does not yield rows.
    await Bun.write(
      path,
      `${JSON.stringify({ version: 2, n: 1, miru: 1, grep: 2, saved: 1, pct_sum: 50, repos: {} })}\n`,
    );
    const loaded = await loadBenchmarkHistory(path);
    expect(loaded.n).toBe(0);
    const bakEntries = (await readdir(dir)).filter((name) =>
      name.startsWith("benchmark-history.json.bak."),
    );
    expect(bakEntries.length).toBe(1);
  });
});
