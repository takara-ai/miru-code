import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveMiruStateDir } from "../credentials.ts";
import { isGitUrl } from "../utils.ts";
import { agentBenchmarkFromTokens } from "./summary.ts";
import type { AgentBenchmarkRollup, AgentBenchmarkSummary, SearchBenchmarkBlock } from "./types.ts";

/**
 * Global rolled-up benchmark report filename under Miru's state directory
 * (e.g. `~/Library/Application Support/miru/benchmark-history.json` on macOS).
 * Override with `MIRU_BENCHMARK_HISTORY_PATH`. Cleared on `miru uninstall`
 * or `miru benchmark clear`.
 */
const HISTORY_FILENAME = "benchmark-history.json";
const HISTORY_VERSION = 1;
export const DEFAULT_MAX_QUERIES = 500;

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

const historyPathStore = new AsyncLocalStorage<string>();
/** In-process serialize of appends per history path. */
const appendChains = new Map<string, Promise<void>>();

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

/**
 * Normalize repo keys for history storage and `read_benchmark` filters:
 * resolve local paths and strip trailing slashes.
 */
export function normalizeBenchmarkRepoKey(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (isGitUrl(trimmed)) {
    return trimmed.replace(/\/+$/, "") || trimmed;
  }
  let resolved = resolve(trimmed);
  while (resolved.length > 1 && (resolved.endsWith("/") || resolved.endsWith("\\"))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
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
    r: normalizeBenchmarkRepoKey(repo),
    m: summary.miru_tok,
    g: summary.grep_tok,
    s: summary.saved_tok,
    p: summary.save_pct,
  };
}

async function rotateCorruptHistory(path: string): Promise<string | undefined> {
  const bak = `${path}.bak.${Date.now()}`;
  try {
    await rename(path, bak);
    return bak;
  } catch {
    return undefined;
  }
}

function emptyHistory(): BenchmarkHistoryFile {
  return { version: HISTORY_VERSION, queries: [] };
}

/**
 * Load history. Corrupt or wrong-version files are rotated aside (`*.bak.<ts>`)
 * instead of being silently overwritten on the next append.
 */
export async function loadBenchmarkHistory(
  path: string = resolveBenchmarkHistoryPath(),
): Promise<BenchmarkHistoryFile> {
  if (!(await Bun.file(path).exists())) {
    return emptyHistory();
  }
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as Partial<BenchmarkHistoryFile>;
    if (parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.queries)) {
      await rotateCorruptHistory(path);
      return emptyHistory();
    }
    return { version: HISTORY_VERSION, queries: parsed.queries };
  } catch {
    await rotateCorruptHistory(path);
    return emptyHistory();
  }
}

async function writeHistoryAtomic(path: string, history: BenchmarkHistoryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(history)}\n`);
  await rename(tmp, path);
}

async function withHistoryFileLock<T>(historyPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${historyPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "EEXIST") {
        throw err;
      }
      try {
        const lockFile = Bun.file(lockPath);
        if (await lockFile.exists()) {
          const text = await lockFile.text();
          const ts = Number(text.trim().split("\n")[1]);
          if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_MS) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        }
      } catch {
        // ignore lock-stat errors and retry / fall through
      }
      if (Date.now() >= deadline) {
        // Best-effort: prefer recording over failing tool calls.
        return await fn();
      }
      await Bun.sleep(15);
    }
  }
}

async function appendBenchmarkQueryUnlocked(
  record: BenchmarkQueryRecord,
  path: string,
  maxQueries: number,
): Promise<void> {
  await withHistoryFileLock(path, async () => {
    const history = await loadBenchmarkHistory(path);
    history.queries.push(record);
    if (history.queries.length > maxQueries) {
      history.queries = history.queries.slice(history.queries.length - maxQueries);
    }
    await writeHistoryAtomic(path, history);
  });
}

export async function appendBenchmarkQuery(
  record: BenchmarkQueryRecord,
  options?: { path?: string; maxQueries?: number },
): Promise<void> {
  const path = options?.path ?? resolveBenchmarkHistoryPath();
  const maxQueries = options?.maxQueries ?? DEFAULT_MAX_QUERIES;

  const prev = appendChains.get(path) ?? Promise.resolve();
  const next = prev.then(
    () => appendBenchmarkQueryUnlocked(record, path, maxQueries),
    () => appendBenchmarkQueryUnlocked(record, path, maxQueries),
  );
  appendChains.set(path, next);
  try {
    await next;
  } finally {
    if (appendChains.get(path) === next) {
      appendChains.delete(path);
    }
  }
}

export function rollupBenchmarkQueries(
  queries: BenchmarkQueryRecord[],
  options?: { repo?: string; recentLimit?: number },
): BenchmarkRollup {
  const want = options?.repo ? normalizeBenchmarkRepoKey(options.repo) : undefined;
  const filtered = want
    ? queries.filter((entry) => normalizeBenchmarkRepoKey(entry.r) === want)
    : queries;
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
    const repoKey = normalizeBenchmarkRepoKey(entry.r);
    const current = byRepoMap.get(repoKey) ?? {
      query_count: 0,
      total_tokens_saved: 0,
      savings_pct_sum: 0,
    };
    current.query_count += 1;
    current.total_tokens_saved += entry.s;
    current.savings_pct_sum += entry.p;
    byRepoMap.set(repoKey, current);
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
