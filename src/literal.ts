/** Exact literal location over already-indexed Miru chunks (no disk re-walk). */

import type { Chunk } from "./types.ts";

export type LiteralMode = "count" | "locations" | "lines";

export interface LiteralHit {
  file_path: string;
  line: number;
  /** Present only in `lines` mode. */
  text?: string;
}

export interface LiteralLocateResult {
  literal: string;
  mode: LiteralMode;
  /** Total unique file:line matches. */
  n: number;
  /** Unique files with at least one match. */
  files: number;
  /** True only when an explicit `limit` cut the hit list short. */
  truncated: boolean;
  hits: LiteralHit[];
}

export interface LiteralLocateOptions {
  mode?: LiteralMode;
  /**
   * Optional cap on returned hits (ignored for `count`).
   * Omit for all matches — agents must not fall back to Grep when truncated.
   */
  limit?: number;
  ignore_case?: boolean;
}

function resolveLimit(limit: number | undefined): number | null {
  if (limit == null || !Number.isFinite(limit)) {
    return null;
  }
  return Math.max(1, Math.floor(limit));
}

function includesLiteral(haystack: string, needle: string, ignoreCase: boolean): boolean {
  if (!ignoreCase) {
    return haystack.includes(needle);
  }
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Scan indexed chunks for an exact substring. Dedupes by file:line when chunks overlap.
 * Only covers indexed content (same corpus as `search` / `expand`).
 * Returns every match unless `limit` is set.
 */
export function locateLiteral(
  chunks: readonly Chunk[],
  literal: string,
  options: LiteralLocateOptions = {},
): LiteralLocateResult {
  const needle = literal;
  const mode = options.mode ?? "lines";
  const ignoreCase = options.ignore_case === true;
  const limit = resolveLimit(options.limit);

  if (!needle) {
    return { literal: needle, mode, n: 0, files: 0, truncated: false, hits: [] };
  }

  const seen = new Set<string>();
  const fileSet = new Set<string>();
  const hits: LiteralHit[] = [];
  let n = 0;

  for (const chunk of chunks) {
    if (!includesLiteral(chunk.content, needle, ignoreCase)) {
      continue;
    }
    const lines = chunk.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      if (!includesLiteral(lineText, needle, ignoreCase)) {
        continue;
      }
      const line = chunk.start_line + i;
      const key = `${chunk.file_path}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      fileSet.add(chunk.file_path);
      n += 1;
      if (mode === "count") {
        continue;
      }
      if (limit != null && hits.length >= limit) {
        continue;
      }
      const hit: LiteralHit = { file_path: chunk.file_path, line };
      if (mode === "lines") {
        hit.text = lineText;
      }
      hits.push(hit);
    }
  }

  return {
    literal: needle,
    mode,
    n,
    files: fileSet.size,
    truncated: mode !== "count" && limit != null && n > hits.length,
    hits: mode === "count" ? [] : hits,
  };
}

/** Compact agent-facing JSON (minimal keys). */
export function formatLiteralLocate(result: LiteralLocateResult): Record<string, unknown> {
  const base: Record<string, unknown> = {
    literal: result.literal,
    mode: result.mode,
    n: result.n,
    files: result.files,
  };

  if (result.mode === "count") {
    return base;
  }

  if (result.truncated) {
    base.truncated = true;
  }
  base.hits = result.hits.map((hit) => {
    if (hit.text !== undefined) {
      return { f: hit.file_path, l: hit.line, t: hit.text };
    }
    return { f: hit.file_path, l: hit.line };
  });
  return base;
}
