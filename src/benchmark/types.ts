export interface SearchBenchmarkBlock {
  mode: true;
  token_count_method: "wordpiece";
  tokenizer_json: string | null;
  miru: {
    search_tokens: number;
    workflow_tokens: number;
    latency_ms: number;
    top_file: string | null;
    top_files: string[];
  };
  grep_read: {
    search_tokens: number;
    read_full_tokens: number;
    read_window_tokens: number;
    workflow_full_tokens: number;
    workflow_window_tokens: number;
    latency_ms: number;
    top_file: string | null;
    top_files: string[];
    pattern: string | null;
    keywords: string[];
  };
  efficiency: {
    token_savings_pct: number;
    baseline: "grep_search_plus_read_full";
  };
  accuracy: {
    rank1_match: boolean;
    top_k_overlap_pct: number;
    miru_only: string[];
    grep_only: string[];
    labeled_recall?: {
      miru: boolean;
      grep: boolean;
    };
  };
  overhead: {
    parallel_total_ms: number;
    miru_share_ms: number;
    grep_share_ms: number;
  };
}

/** Compact per-search stats attached to MCP `search` responses (agent-facing). */
export interface AgentBenchmarkSummary {
  save_pct: number;
  miru_tok: number;
  grep_tok: number;
  saved_tok: number;
  rank1: boolean;
  /** Present only when non-empty; capped at 3 paths. */
  miru_only?: string[];
}

/** Compact cumulative rollup for MCP `read_benchmark` (agent-facing). */
export interface AgentBenchmarkRollup {
  n: number;
  saved: number;
  save_pct: number;
  miru: number;
  grep: number;
  /** Only when more than one repo is present. */
  repos?: Array<{ r: string; n: number; saved: number; save_pct: number }>;
  /** Only when recent_limit > 0. */
  recent?: Array<{ q: string; saved: number; pct: number }>;
}
