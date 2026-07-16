/**
 * Compare Miru `locate` agent payload tokens vs the costlier native Grep path.
 *
 * Baseline mirrors Cursor/Claude Grep-style output: fixed-string matches with
 * ±GREP_CONTEXT lines (not slim `rg -n`). That is the expensive path agents
 * take without `locate`, so savings measure real workflow cost — not an
 * apples-to-apples payload contest against optimally-minimal ripgrep.
 */

import {
  DEFAULT_LITERAL_MODE,
  formatLiteralLocate,
  type LiteralLocateOptions,
  type LiteralLocateResult,
} from "../literal.ts";
import type { MiruIndex } from "../miru-index.ts";
import { countTokens } from "../token-count.ts";
import { GREP_CONTEXT } from "./grep.ts";
import { rgLiteralOutput } from "./rg-literal.ts";
import { agentBenchmarkFromTokens } from "./summary.ts";
import type { AgentBenchmarkSummary } from "./types.ts";

export { attachAgentBenchmark as attachLocateBenchmark } from "./summary.ts";

export interface LocateBenchmarkComparison {
  result: LiteralLocateResult;
  payload: Record<string, unknown>;
  benchmark: AgentBenchmarkSummary;
  latency_ms: {
    miru: number;
    grep: number;
  };
}

export async function benchmarkLocateComparison(options: {
  literal: string;
  repoPath: string;
  index: MiruIndex;
  locate?: LiteralLocateOptions;
}): Promise<LocateBenchmarkComparison> {
  const locateOpts: LiteralLocateOptions = { mode: DEFAULT_LITERAL_MODE, ...options.locate };

  const miruStart = performance.now();
  const result = options.index.locateLiteral(options.literal, locateOpts);
  const miruMs = performance.now() - miruStart;
  const payload = formatLiteralLocate(result);
  const miruTok = countTokens(JSON.stringify(payload));

  // Unbounded agent-style Grep dump (±context) — the costlier path without locate.
  // Never use less context than the caller actually requested via context_lines,
  // or a locate call that returns inline context looks artificially expensive
  // against a baseline that didn't have to fetch that context at all.
  const grep = await rgLiteralOutput(options.repoPath, options.literal, {
    context: Math.max(GREP_CONTEXT, locateOpts.context_lines ?? 0),
    maxCount: 0,
    ignoreCase: locateOpts.ignore_case,
  });

  return {
    result,
    payload,
    benchmark: agentBenchmarkFromTokens(miruTok, grep.tokens, result.n > 0),
    latency_ms: { miru: miruMs, grep: grep.latency_ms },
  };
}
