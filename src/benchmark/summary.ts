import type { AgentBenchmarkSummary } from "./types.ts";

/** Percent of baseline tokens avoided by Miru (0–100). */
export function tokenSavingsPct(miruTok: number, grepTok: number): number {
  return grepTok > 0 ? Math.round((1 - miruTok / grepTok) * 100) : 0;
}

/** Compact agent-facing savings from Miru vs Grep token counts. */
export function agentBenchmarkFromTokens(
  miruTok: number,
  grepTok: number,
  rank1: boolean,
): AgentBenchmarkSummary {
  return {
    save_pct: tokenSavingsPct(miruTok, grepTok),
    miru_tok: miruTok,
    grep_tok: grepTok,
    saved_tok: Math.max(0, grepTok - miruTok),
    rank1,
  };
}

/** Attach compact `benchmark` to an MCP tool payload (JSON path / tests). */
export function attachAgentBenchmark<T extends Record<string, unknown>>(
  payload: T,
  benchmark: AgentBenchmarkSummary,
): T & { benchmark: AgentBenchmarkSummary } {
  return { ...payload, benchmark };
}

/**
 * Append a compact trailing JSON object so plaintext MCP bodies can still expose
 * `benchmark` without wrapping the result in JSON scaffolding.
 * `miru_tok` counts the body only — never this trailer.
 */
export function appendAgentBenchmark(body: string, benchmark: AgentBenchmarkSummary): string {
  return `${body}\n\n${JSON.stringify({ benchmark })}`;
}
