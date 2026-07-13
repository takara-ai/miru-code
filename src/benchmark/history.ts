import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveMiruStateDir } from "../credentials.ts";
import { agentBenchmarkFromTokens } from "./summary.ts";
import type { AgentBenchmarkRollup, AgentBenchmarkSummary, SearchBenchmarkBlock } from "./types.ts";

/**
 * Global rolled-up benchmark report filename under Miru's state directory
 * (e.g. `~/Library/Application Support/miru/benchmark-history.json` on macOS).
 * Override with `MIRU_BENCHMARK_HISTORY_PATH`. Cleared on `miru uninstall`.
 */
const HISTORY_FILENAME = "benchmark-history.json";
const HISTORY_VERSION = 1;
const DEFAULT_MAX_QUERIES = 500;

const historyPathStore = new AsyncLocalStorage<string>();

/** Run `fn` with a request-scoped history path (safe under parallel tests). */
export function runWithBenchmarkHistoryPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return historyPathStore.run(path, fn);
}

/** Compact on-disk / internal query row (short keys). */
export interface BenchmarkQueryRecord {
  at: string;
  q: string;
  r: string;
  m: number;
  g: number;
  s: number;
  p: number;
}

export interface BenchmarkHistoryFile {
  version: typeof HISTORY_VERSION;
  queries: BenchmarkQueryRecord[];
}

export interface BenchmarkRollup {
  query_count: number;
  total_miru_workflow_tokens: number;
  total_grep_workflow_full_tokens: number;
  total_tokens_saved: number;
  mean_token_savings_pct: number;
  by_repo: Array<{
    repo: string;
    query_count: number;
    total_tokens_saved: number;
    mean_token_savings_pct: number;
  }>;
  recent_queries: BenchmarkQueryRecord[];
}

export function resolveBenchmarkHistoryPath(): string {
  const fromStore = historyPathStore.getStore();
  if (fromStore) {
    return fromStore;
  }
  const override = process.env.MIRU_BENCHMARK_HISTORY_PATH?.trim();
  if (override) {
    return override;
  }
  return join(resolveMiruStateDir(), HISTORY_FILENAME);
}

/** Delete the global benchmark report. No-op when missing. */
export async function clearBenchmarkHistory(
  path: string = resolveBenchmarkHistoryPath(),
): Promise<{ cleared: boolean; path: string }> {
  if (!(await Bun.file(path).exists())) {
    return { cleared: false, path };
  }
  await Bun.file(path).delete();
  return { cleared: true, path };
}

export function recordFromBenchmark(
  query: string,
  repo: string,
  benchmark: SearchBenchmarkBlock,
  recordedAt: Date = new Date(),
): BenchmarkQueryRecord {
  const summary = agentBenchmarkFromTokens(
    benchmark.miru.workflow_tokens,
    benchmark.grep_read.workflow_full_tokens,
    benchmark.accuracy.rank1_match,
  );
  // Keep the search block's precomputed savings pct (authoritative for history).
  summary.save_pct = benchmark.efficiency.token_savings_pct;
  return recordFromAgentSummary(query, repo, summary, recordedAt);
}

/** Persist compact agent-facing savings (search or locate). */
export function recordFromAgentSummary(
  query: string,
  repo: string,
  summary: Pick<AgentBenchmarkSummary, "miru_tok" | "grep_tok" | "save_pct" | "saved_tok">,
  recordedAt: Date = new Date(),
): BenchmarkQueryRecord {
  return {
    at: recordedAt.toISOString(),
    q: query,
    r: repo,
    m: summary.miru_tok,
    g: summary.grep_tok,
    s: summary.saved_tok,
    p: summary.save_pct,
  };
}

export async function loadBenchmarkHistory(
  path: string = resolveBenchmarkHistoryPath(),
): Promise<BenchmarkHistoryFile> {
  if (!(await Bun.file(path).exists())) {
    return { version: HISTORY_VERSION, queries: [] };
  }
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as Partial<BenchmarkHistoryFile>;
    if (parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.queries)) {
      return { version: HISTORY_VERSION, queries: [] };
    }
    return { version: HISTORY_VERSION, queries: parsed.queries };
  } catch {
    return { version: HISTORY_VERSION, queries: [] };
  }
}

export async function appendBenchmarkQuery(
  record: BenchmarkQueryRecord,
  options?: { path?: string; maxQueries?: number },
): Promise<void> {
  const path = options?.path ?? resolveBenchmarkHistoryPath();
  const maxQueries = options?.maxQueries ?? DEFAULT_MAX_QUERIES;
  const history = await loadBenchmarkHistory(path);
  history.queries.push(record);
  if (history.queries.length > maxQueries) {
    history.queries = history.queries.slice(history.queries.length - maxQueries);
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(history)}\n`);
}

export function rollupBenchmarkQueries(
  queries: BenchmarkQueryRecord[],
  options?: { repo?: string; recentLimit?: number },
): BenchmarkRollup {
  const filtered = options?.repo ? queries.filter((entry) => entry.r === options.repo) : queries;
  const recentLimit = options?.recentLimit ?? 0;
  const n = filtered.length;

  if (n === 0) {
    return {
      query_count: 0,
      total_miru_workflow_tokens: 0,
      total_grep_workflow_full_tokens: 0,
      total_tokens_saved: 0,
      mean_token_savings_pct: 0,
      by_repo: [],
      recent_queries: [],
    };
  }

  const totalMiru = filtered.reduce((sum, row) => sum + row.m, 0);
  const totalGrep = filtered.reduce((sum, row) => sum + row.g, 0);
  const totalSaved = filtered.reduce((sum, row) => sum + row.s, 0);
  const meanSavingsPct = filtered.reduce((sum, row) => sum + row.p, 0) / n;

  const byRepoMap = new Map<
    string,
    { query_count: number; total_tokens_saved: number; savings_pct_sum: number }
  >();
  for (const entry of filtered) {
    const current = byRepoMap.get(entry.r) ?? {
      query_count: 0,
      total_tokens_saved: 0,
      savings_pct_sum: 0,
    };
    current.query_count += 1;
    current.total_tokens_saved += entry.s;
    current.savings_pct_sum += entry.p;
    byRepoMap.set(entry.r, current);
  }

  const by_repo = [...byRepoMap.entries()]
    .map(([repo, stats]) => ({
      repo,
      query_count: stats.query_count,
      total_tokens_saved: stats.total_tokens_saved,
      mean_token_savings_pct: Math.round(stats.savings_pct_sum / stats.query_count),
    }))
    .sort((a, b) => b.total_tokens_saved - a.total_tokens_saved);

  return {
    query_count: n,
    total_miru_workflow_tokens: totalMiru,
    total_grep_workflow_full_tokens: totalGrep,
    total_tokens_saved: totalSaved,
    mean_token_savings_pct: Math.round(meanSavingsPct),
    by_repo,
    recent_queries: recentLimit > 0 ? filtered.slice(-recentLimit).reverse() : [],
  };
}

/** Agent-facing rollup: short keys, omit empty optional sections. */
export function toAgentBenchmarkRollup(rollup: BenchmarkRollup): AgentBenchmarkRollup {
  const out: AgentBenchmarkRollup = {
    n: rollup.query_count,
    saved: rollup.total_tokens_saved,
    save_pct: rollup.mean_token_savings_pct,
    miru: rollup.total_miru_workflow_tokens,
    grep: rollup.total_grep_workflow_full_tokens,
  };
  if (rollup.by_repo.length > 1) {
    out.repos = rollup.by_repo.map((row) => ({
      r: row.repo,
      n: row.query_count,
      saved: row.total_tokens_saved,
      save_pct: row.mean_token_savings_pct,
    }));
  }
  if (rollup.recent_queries.length > 0) {
    out.recent = rollup.recent_queries.map((row) => ({
      q: row.q,
      saved: row.s,
      pct: row.p,
    }));
  }
  return out;
}

export async function readBenchmarkRollup(options?: {
  path?: string;
  repo?: string;
  recentLimit?: number;
}): Promise<AgentBenchmarkRollup> {
  const path = options?.path ?? resolveBenchmarkHistoryPath();
  const history = await loadBenchmarkHistory(path);
  return toAgentBenchmarkRollup(
    rollupBenchmarkQueries(history.queries, {
      repo: options?.repo,
      recentLimit: options?.recentLimit ?? 0,
    }),
  );
}
