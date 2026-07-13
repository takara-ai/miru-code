import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MiruIndex } from "../miru-index.ts";
import { applySnippetsToResults, estimateResultTokens } from "../snippet.ts";
import { countTokens, tokenCountMethod, tokenizerJsonPath } from "../token-count.ts";
import type { SearchResult } from "../types.ts";
import { dedupeResultsByFile, expandChunksAtLine } from "../utils.ts";
import { type GrepFileHit, grepSearch } from "./grep.ts";
import type { AgentBenchmarkSummary, SearchBenchmarkBlock } from "./types.ts";

const EXPAND_BEFORE = 1;
const EXPAND_AFTER = 1;

function pathMatches(filePath: string, targetPath: string): boolean {
  const normFile = filePath.replaceAll("\\", "/");
  const normTarget = targetPath.replaceAll("\\", "/");
  return (
    normFile === normTarget ||
    normFile.endsWith(`/${normTarget}`) ||
    normTarget.endsWith(`/${normFile}`)
  );
}

function firstGrepMatchLine(hit: GrepFileHit | undefined): number | null {
  if (!hit?.output) {
    return null;
  }
  for (const line of hit.output.split("\n")) {
    if (!line.trim() || line === "--") {
      continue;
    }
    const withPath = line.match(/:(\d+)[:-]/);
    if (withPath?.[1]) {
      return Number(withPath[1]);
    }
    const bare = line.match(/^(\d+)[:-]/);
    if (bare?.[1]) {
      return Number(bare[1]);
    }
  }
  return null;
}

function expandLineSpan(chunks: { start_line: number; end_line: number }[]): number {
  if (chunks.length === 0) {
    return 0;
  }
  const start = Math.min(...chunks.map((c) => c.start_line));
  const end = Math.max(...chunks.map((c) => c.end_line));
  return end - start + 1;
}

async function readFileTokens(absPath: string): Promise<number> {
  try {
    const text = await readFile(absPath, "utf-8");
    return countTokens(text);
  } catch {
    return 0;
  }
}

async function readLineWindowTokens(
  absPath: string,
  centerLine: number,
  lineSpan: number,
): Promise<number> {
  try {
    const text = await readFile(absPath, "utf-8");
    const lines = text.split("\n");
    if (lines.length === 0) {
      return 0;
    }
    const half = Math.max(1, Math.floor(lineSpan / 2));
    const start = Math.max(1, centerLine - half);
    const end = Math.min(lines.length, centerLine + half);
    return countTokens(lines.slice(start - 1, end).join("\n"));
  } catch {
    return 0;
  }
}

function miruExpandTokens(
  index: MiruIndex,
  repoPath: string,
  top: SearchResult | undefined,
  query: string,
): { tokens: number; lineSpan: number } {
  if (!top) {
    return { tokens: 0, lineSpan: 0 };
  }
  const [{ meta }] = applySnippetsToResults([top], query);
  const line = meta.truncated ? meta.anchor_line : top.chunk.start_line;
  const { chunks } = expandChunksAtLine(
    index.chunks,
    top.chunk.file_path,
    line,
    repoPath,
    EXPAND_BEFORE,
    EXPAND_AFTER,
  );
  return {
    tokens: chunks.reduce((sum, chunk) => sum + countTokens(chunk.content), 0),
    lineSpan: expandLineSpan(chunks),
  };
}

function topKOverlapPct(miruFiles: string[], grepFiles: string[]): number {
  if (miruFiles.length === 0 && grepFiles.length === 0) {
    return 100;
  }
  const union = new Set([...miruFiles, ...grepFiles]);
  if (union.size === 0) {
    return 0;
  }
  const overlap = miruFiles.filter((file) => grepFiles.includes(file)).length;
  return Math.round((overlap / union.size) * 100);
}

function uniqueFiles(files: string[], other: string[]): string[] {
  return files.filter((file) => !other.includes(file));
}

async function grepReadEstimates(
  repoPath: string,
  grep: Awaited<ReturnType<typeof grepSearch>>,
  matchedLineSpan: number,
): Promise<{ readFull: number; readWindow: number; latencyMs: number }> {
  const start = performance.now();
  const topGrepHit = grep.hits[0];
  const grepTop = topGrepHit?.file ?? null;
  const grepAbsPath = grepTop ? join(repoPath, grepTop) : null;
  const grepMatchLine = firstGrepMatchLine(topGrepHit);
  const readFull = grepAbsPath ? await readFileTokens(grepAbsPath) : 0;
  const span = matchedLineSpan > 0 ? matchedLineSpan : 60;
  const readWindow =
    grepAbsPath && grepMatchLine != null
      ? await readLineWindowTokens(grepAbsPath, grepMatchLine, span)
      : 0;
  return {
    readFull,
    readWindow,
    latencyMs: performance.now() - start,
  };
}

export async function benchmarkSearchComparison(options: {
  query: string;
  repoPath: string;
  index: MiruIndex;
  topK: number;
  relevant?: string[];
}): Promise<{ benchmark: SearchBenchmarkBlock; results: SearchResult[] }> {
  const { query, repoPath, index, topK, relevant } = options;
  const parallelStart = performance.now();

  const miruPromise = (async () => {
    const started = performance.now();
    const raw = await index.search({ query, topK, rerank: true });
    const results = dedupeResultsByFile(raw).slice(0, topK);
    const snippetResults = applySnippetsToResults(results, query).map((entry) => entry.result);
    const searchTokens = estimateResultTokens(snippetResults);
    const expand = miruExpandTokens(index, repoPath, results[0], query);
    return {
      results,
      searchTokens,
      workflowTokens: searchTokens + expand.tokens,
      lineSpan: expand.lineSpan,
      latencyMs: performance.now() - started,
    };
  })();

  const grepSearchPromise = (async () => {
    const started = performance.now();
    const grep = await grepSearch(repoPath, query, topK);
    return { grep, latencyMs: performance.now() - started };
  })();

  const [miruOutcome, grepSearchOutcome] = await Promise.all([miruPromise, grepSearchPromise]);
  const grepReads = await grepReadEstimates(repoPath, grepSearchOutcome.grep, miruOutcome.lineSpan);

  const parallelTotalMs = performance.now() - parallelStart;
  const grepOutcome = {
    grep: grepSearchOutcome.grep,
    readFull: grepReads.readFull,
    readWindow: grepReads.readWindow,
    latencyMs: grepSearchOutcome.latencyMs + grepReads.latencyMs,
  };
  const miruFiles = miruOutcome.results.map((result) => result.chunk.file_path);
  const grepFiles = grepOutcome.grep.files;
  const miruTop = miruFiles[0] ?? null;
  const grepTop = grepFiles[0] ?? null;
  const workflowFull = grepOutcome.grep.tokens + grepOutcome.readFull;
  const workflowWindow = grepOutcome.grep.tokens + grepOutcome.readWindow;
  const tokenSavings =
    workflowFull > 0 ? Math.round((1 - miruOutcome.workflowTokens / workflowFull) * 100) : 0;

  const block: SearchBenchmarkBlock = {
    mode: true,
    token_count_method: tokenCountMethod(),
    tokenizer_json: tokenizerJsonPath(),
    miru: {
      search_tokens: miruOutcome.searchTokens,
      workflow_tokens: miruOutcome.workflowTokens,
      latency_ms: Math.round(miruOutcome.latencyMs),
      top_file: miruTop,
      top_files: miruFiles,
    },
    grep_read: {
      search_tokens: grepOutcome.grep.tokens,
      read_full_tokens: grepOutcome.readFull,
      read_window_tokens: grepOutcome.readWindow,
      workflow_full_tokens: workflowFull,
      workflow_window_tokens: workflowWindow,
      latency_ms: Math.round(grepOutcome.latencyMs),
      top_file: grepTop,
      top_files: grepFiles,
      pattern: grepOutcome.grep.pattern,
      keywords: grepOutcome.grep.keywords,
    },
    efficiency: {
      token_savings_pct: tokenSavings,
      baseline: "grep_search_plus_read_full",
    },
    accuracy: {
      rank1_match: miruTop != null && miruTop === grepTop,
      top_k_overlap_pct: topKOverlapPct(miruFiles, grepFiles),
      miru_only: uniqueFiles(miruFiles, grepFiles),
      grep_only: uniqueFiles(grepFiles, miruFiles),
    },
    overhead: {
      parallel_total_ms: Math.round(parallelTotalMs),
      miru_share_ms: Math.round(miruOutcome.latencyMs),
      grep_share_ms: Math.round(grepOutcome.latencyMs),
    },
  };

  if (relevant && relevant.length > 0) {
    block.accuracy.labeled_recall = {
      miru: relevant.some((want) => miruFiles.some((file) => pathMatches(file, want))),
      grep: relevant.some((want) => grepFiles.some((file) => pathMatches(file, want))),
    };
  }

  return { benchmark: block, results: miruOutcome.results };
}

const MAX_AGENT_MIRU_ONLY = 3;

/** Strip internal/debug fields down to the compact MCP agent payload. */
export function toAgentBenchmarkSummary(block: SearchBenchmarkBlock): AgentBenchmarkSummary {
  const miruTok = block.miru.workflow_tokens;
  const grepTok = block.grep_read.workflow_full_tokens;
  const summary: AgentBenchmarkSummary = {
    save_pct: block.efficiency.token_savings_pct,
    miru_tok: miruTok,
    grep_tok: grepTok,
    saved_tok: Math.max(0, grepTok - miruTok),
    rank1: block.accuracy.rank1_match,
  };
  if (block.accuracy.miru_only.length > 0) {
    summary.miru_only = block.accuracy.miru_only.slice(0, MAX_AGENT_MIRU_ONLY);
  }
  return summary;
}

export function attachSearchBenchmark<T extends Record<string, unknown>>(
  payload: T,
  benchmark: SearchBenchmarkBlock,
): T & { benchmark: AgentBenchmarkSummary } {
  return { ...payload, benchmark: toAgentBenchmarkSummary(benchmark) };
}
