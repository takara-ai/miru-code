/**
 * Compare Miru `locate` MCP response tokens vs the costlier native Grep path.
 *
 * Miru side counts the agent-facing text body (`formatLiteralLocateText`), not
 * the intermediate JSON payload. The grep baseline requests only the same
 * information: counts for `count`, line locations for `locations`, and context
 * for `lines`. It also mirrors locate's include/exclude scope and variants.
 */

import { join } from "node:path";
import {
  DEFAULT_LITERAL_MODE,
  filterChunksByGlob,
  formatLiteralLocate,
  type LiteralLocateOptions,
  type LiteralLocateResult,
} from "../literal.ts";
import { formatLiteralLocateText } from "../mcp/format-text.ts";
import type { MiruIndex } from "../miru-index.ts";
import { countTokens } from "../token-count.ts";
import { GREP_CONTEXT } from "./grep.ts";
import { rgLiteralOutput, selectComparableLiteralSearchTool } from "./rg-literal.ts";
import { agentBenchmarkFromTokens } from "./summary.ts";
import type { AgentBenchmarkSummary } from "./types.ts";

export { attachAgentBenchmark as attachLocateBenchmark } from "./summary.ts";

export interface LocateBenchmarkComparison {
  result: LiteralLocateResult;
  payload: Record<string, unknown>;
  benchmark: AgentBenchmarkSummary;
  /** Baseline match stats; compare with `result.n`/`result.files` for exact-literal parity. */
  grep: { n: number; files: number };
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
  if (options.locate?.limit != null) {
    throw new Error(
      "Cannot benchmark a limited locate response against native grep: rg/grep limits are per file, while locate.limit is global. Omit limit to keep token and recall comparisons valid.",
    );
  }
  if (!selectComparableLiteralSearchTool()) {
    throw new Error(
      "A comparable literal benchmark requires rg or compatible grep; findstr is not equivalent for scoped locate output.",
    );
  }
  const locateOpts: LiteralLocateOptions = { mode: DEFAULT_LITERAL_MODE, ...options.locate };

  const miruStart = performance.now();
  const result = options.index.locateLiteral(options.literal, locateOpts);
  const miruMs = performance.now() - miruStart;
  const payload = formatLiteralLocate(result);
  const miruTok = countTokens(formatLiteralLocateText(payload));

  // Grep every variant `match_variants`/an array `literal` actually matched — one
  // pattern is not equivalent recall. Keep contextual lines only for `lines` mode.
  const context =
    locateOpts.mode === "lines" ? Math.max(GREP_CONTEXT, locateOpts.context_lines ?? 0) : 0;
  const indexedPaths = [
    ...new Set(
      filterChunksByGlob(options.index.chunks, locateOpts.include, locateOpts.exclude).map(
        (chunk) => join(options.repoPath, chunk.file_path),
      ),
    ),
  ];
  const grep = await rgLiteralOutput(options.repoPath, result.literals ?? [options.literal], {
    context,
    maxCount: 0,
    ignoreCase: locateOpts.ignore_case,
    countOnly: locateOpts.mode === "count",
    paths: indexedPaths,
  });

  return {
    result,
    payload,
    benchmark: agentBenchmarkFromTokens(miruTok, grep.tokens, result.n > 0),
    grep: { n: grep.n, files: grep.files },
    latency_ms: { miru: miruMs, grep: grep.latency_ms },
  };
}
