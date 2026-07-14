/**
 * Benchmark mode history: JSONL of `{ r, m, g, s, p }` (repo + token deltas, no
 * query text). Appends use `O_APPEND` (no lock). `read_benchmark` sums the file.
 *
 * Path: `<miru-state>/benchmark-history.json`, or `MIRU_BENCHMARK_HISTORY_PATH`.
 * Cleared by `miru benchmark clear` / `miru uninstall`.
 * Tests: `runWithBenchmarkHistoryPath` (AsyncLocalStorage).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveMiruStateDir } from "../credentials.ts";
import { isGitUrl } from "../utils.ts";
import { agentBenchmarkFromTokens } from "./summary.ts";
import type { AgentBenchmarkRollup, AgentBenchmarkSummary, SearchBenchmarkBlock } from "./types.ts";

const HISTORY_FILENAME = "benchmark-history.json";
const historyPathStore = new AsyncLocalStorage<string>();

/** One JSONL line: r=repo, m=miru, g=grep, s=saved, p=save_pct. */
export interface BenchmarkContribution {
  r: string;
  m: number;
  g: number;
  s: number;
  p: number;
}

/** Totals for one repo (or the global fold). pct_sum → mean = round(pct_sum / n). */
export interface TokenTotals {
  n: number;
  miru: number;
  grep: number;
  saved: number;
  pct_sum: number;
}

/** In-memory fold of the JSONL file. */
export interface BenchmarkHistoryFile extends TokenTotals {
  repos: Record<string, TokenTotals>;
}

export function runWithBenchmarkHistoryPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return historyPathStore.run(path, fn);
}

export function resolveBenchmarkHistoryPath(): string {
  return (
    historyPathStore.getStore() ??
    process.env.MIRU_BENCHMARK_HISTORY_PATH?.trim() ??
    join(resolveMiruStateDir(), HISTORY_FILENAME)
  );
}

/** Absolute local path (no trailing slash), or git URL with trailing slashes stripped. */
export function normalizeBenchmarkRepoKey(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) return trimmed;
  if (isGitUrl(trimmed)) return trimmed.replace(/\/+$/, "") || trimmed;
  return resolve(trimmed).replace(/[/\\]+$/, "") || resolve(trimmed);
}

export function recordFromBenchmark(
  repo: string,
  benchmark: SearchBenchmarkBlock,
): BenchmarkContribution {
  const summary = agentBenchmarkFromTokens(
    benchmark.miru.workflow_tokens,
    benchmark.grep_read.workflow_full_tokens,
    benchmark.accuracy.rank1_match,
  );
  summary.save_pct = benchmark.efficiency.token_savings_pct;
  return recordFromAgentSummary(repo, summary);
}

export function recordFromAgentSummary(
  repo: string,
  summary: Pick<AgentBenchmarkSummary, "miru_tok" | "grep_tok" | "save_pct" | "saved_tok">,
): BenchmarkContribution {
  return {
    r: normalizeBenchmarkRepoKey(repo),
    m: summary.miru_tok,
    g: summary.grep_tok,
    s: summary.saved_tok,
    p: summary.save_pct,
  };
}

function emptyTotals(): TokenTotals {
  return { n: 0, miru: 0, grep: 0, saved: 0, pct_sum: 0 };
}

function isContribution(value: unknown): value is BenchmarkContribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.r === "string" &&
    [row.m, row.g, row.s, row.p].every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function addContribution(totals: TokenTotals, c: BenchmarkContribution): void {
  totals.n += 1;
  totals.miru += c.m;
  totals.grep += c.g;
  totals.saved += c.s;
  totals.pct_sum += c.p;
}

function foldContributions(rows: BenchmarkContribution[]): BenchmarkHistoryFile {
  const history: BenchmarkHistoryFile = { ...emptyTotals(), repos: {} };
  for (const row of rows) {
    addContribution(history, row);
    const repo = history.repos[row.r] ?? emptyTotals();
    addContribution(repo, row);
    history.repos[row.r] = repo;
  }
  return history;
}

function parseContributions(text: string): BenchmarkContribution[] {
  const out: BenchmarkContribution[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isContribution(parsed)) throw new Error("invalid benchmark history line");
    out.push(parsed);
  }
  return out;
}

async function rotateCorruptHistory(path: string): Promise<void> {
  await rename(path, `${path}.bak.${Date.now()}`).catch(() => {});
}

/** Missing/empty → zeros. Bad line → rotate file aside, return zeros. */
export async function loadBenchmarkHistory(
  path: string = resolveBenchmarkHistoryPath(),
): Promise<BenchmarkHistoryFile> {
  if (!(await Bun.file(path).exists())) return { ...emptyTotals(), repos: {} };
  const text = await Bun.file(path).text();
  if (!text.trim()) return { ...emptyTotals(), repos: {} };
  try {
    return foldContributions(parseContributions(text));
  } catch {
    await rotateCorruptHistory(path);
    return { ...emptyTotals(), repos: {} };
  }
}

export async function clearBenchmarkHistory(
  path: string = resolveBenchmarkHistoryPath(),
): Promise<{ cleared: boolean; path: string }> {
  if (!(await Bun.file(path).exists())) return { cleared: false, path };
  await Bun.file(path).delete();
  return { cleared: true, path };
}

/** Append one JSONL line (`O_APPEND`). */
export async function appendBenchmarkQuery(
  contribution: BenchmarkContribution,
  options?: { path?: string },
): Promise<void> {
  const path = options?.path ?? resolveBenchmarkHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(contribution)}\n`, "utf8");
}

function totalsToRollup(t: TokenTotals): AgentBenchmarkRollup {
  return {
    n: t.n,
    saved: t.saved,
    save_pct: t.n > 0 ? Math.round(t.pct_sum / t.n) : 0,
    miru: t.miru,
    grep: t.grep,
  };
}

/** Optional `repo` filter. With 2+ repos unfiltered, attach `repos` by saved desc. */
export function toAgentBenchmarkRollup(
  history: BenchmarkHistoryFile,
  options?: { repo?: string },
): AgentBenchmarkRollup {
  if (options?.repo) {
    const key = normalizeBenchmarkRepoKey(options.repo);
    return totalsToRollup(history.repos[key] ?? emptyTotals());
  }
  const out = totalsToRollup(history);
  const entries = Object.entries(history.repos);
  if (entries.length > 1) {
    out.repos = entries
      .map(([r, t]) => ({ r, n: t.n, saved: t.saved, save_pct: totalsToRollup(t).save_pct }))
      .sort((a, b) => b.saved - a.saved);
  }
  return out;
}

export async function readBenchmarkRollup(options?: {
  path?: string;
  repo?: string;
}): Promise<AgentBenchmarkRollup> {
  return toAgentBenchmarkRollup(await loadBenchmarkHistory(options?.path), {
    repo: options?.repo,
  });
}
