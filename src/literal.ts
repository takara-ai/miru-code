/** Exact literal location over already-indexed Miru chunks (no disk re-walk). */

import ignore from "ignore";
import type { Chunk } from "./types.ts";

export type LiteralMode = "count" | "locations" | "lines";

export const DEFAULT_LITERAL_MODE: LiteralMode = "lines";

export interface LiteralHit {
  file_path: string;
  line: number;
  /** Present only in `lines` mode. */
  text?: string;
  /** Present only in `lines` mode when `context_lines` is set. */
  context?: string[];
  /** Line number of `context[0]`. */
  context_start_line?: number;
}

export interface LiteralLocateResult {
  /** Human-readable label — the input literal, or `|`-joined for multi-literal calls. */
  literal: string;
  /** All literal variants actually searched (OR-matched). Present only when more than one. */
  literals?: string[];
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
  /**
   * Expand each literal into its identifier-casing variants (camelCase, PascalCase,
   * snake_case, kebab-case, CONSTANT_CASE) and OR-match all of them.
   */
  match_variants?: boolean;
  /** Gitignore-style glob patterns; only chunks from matching files are searched. */
  include?: string[];
  /** Gitignore-style glob patterns; chunks from matching files are skipped. */
  exclude?: string[];
  /** Lines of context before/after each match, `lines` mode only (like `grep -C`). */
  context_lines?: number;
}

function resolveLimit(limit: number | undefined): number | null {
  if (limit == null || !Number.isFinite(limit)) {
    return null;
  }
  return Math.max(1, Math.floor(limit));
}

function lineMatchesAny(
  haystack: string,
  needles: readonly string[],
  ignoreCase: boolean,
): boolean {
  const hay = ignoreCase ? haystack.toLowerCase() : haystack;
  for (const needle of needles) {
    const n = ignoreCase ? needle.toLowerCase() : needle;
    if (hay.includes(n)) {
      return true;
    }
  }
  return false;
}

/** Splits an identifier into lowercase words, honoring camelCase/PascalCase humps and _/- separators. */
function splitIdentifierWords(literal: string): string[] {
  const normalized = literal.replace(/[_\-\s]+/g, " ");
  const humped = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return humped
    .split(" ")
    .map((w) => w.trim())
    .filter(Boolean);
}

/** camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE variants of one identifier. */
function identifierVariants(literal: string): string[] {
  const words = splitIdentifierWords(literal);
  if (words.length === 0) {
    return [];
  }
  const lower = words.map((w) => w.toLowerCase());
  const capitalized = lower.map((w) => w.charAt(0).toUpperCase() + w.slice(1));

  return [
    lower[0] + capitalized.slice(1).join(""),
    capitalized.join(""),
    lower.join("_"),
    lower.join("-"),
    lower.join("_").toUpperCase(),
  ];
}

function expandLiterals(literals: readonly string[], matchVariants: boolean): string[] {
  const seen = new Set<string>();
  for (const lit of literals) {
    if (!lit) {
      continue;
    }
    seen.add(lit);
    if (matchVariants) {
      for (const variant of identifierVariants(lit)) {
        if (variant) {
          seen.add(variant);
        }
      }
    }
  }
  return [...seen];
}

function filterChunksByGlob(
  chunks: readonly Chunk[],
  include: string[] | undefined,
  exclude: string[] | undefined,
): readonly Chunk[] {
  if (!include?.length && !exclude?.length) {
    return chunks;
  }
  const includeMatcher = include?.length ? ignore().add(include) : null;
  const excludeMatcher = exclude?.length ? ignore().add(exclude) : null;

  return chunks.filter((chunk) => {
    const path = chunk.file_path.replace(/^\/+/, "");
    if (includeMatcher && !includeMatcher.ignores(path)) {
      return false;
    }
    if (excludeMatcher && excludeMatcher.ignores(path)) {
      return false;
    }
    return true;
  });
}

/**
 * Scan indexed chunks for an exact substring (or, with an array `literal`/`match_variants`,
 * any of several OR-matched substrings). Dedupes by file:line when chunks overlap.
 * Only covers indexed content (same corpus as `search` / `expand`).
 * Returns every match unless `limit` is set.
 */
export function locateLiteral(
  chunks: readonly Chunk[],
  literal: string | readonly string[],
  options: LiteralLocateOptions = {},
): LiteralLocateResult {
  const mode = options.mode ?? DEFAULT_LITERAL_MODE;
  const ignoreCase = options.ignore_case === true;
  const limit = resolveLimit(options.limit);
  const contextLines =
    options.context_lines != null && Number.isFinite(options.context_lines)
      ? Math.max(0, Math.floor(options.context_lines))
      : 0;

  const inputLiterals = (Array.isArray(literal) ? literal : [literal]).filter((l) => l.length > 0);
  const label = inputLiterals.join(" | ");
  const needles = expandLiterals(inputLiterals, options.match_variants === true);

  if (needles.length === 0) {
    return { literal: label, mode, n: 0, files: 0, truncated: false, hits: [] };
  }

  const scopedChunks = filterChunksByGlob(chunks, options.include, options.exclude);

  const seen = new Set<string>();
  const fileSet = new Set<string>();
  const hits: LiteralHit[] = [];
  let n = 0;

  for (const chunk of scopedChunks) {
    if (!lineMatchesAny(chunk.content, needles, ignoreCase)) {
      continue;
    }
    const lines = chunk.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      if (!lineMatchesAny(lineText, needles, ignoreCase)) {
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
        if (contextLines > 0) {
          const ctxStart = Math.max(0, i - contextLines);
          const ctxEnd = Math.min(lines.length - 1, i + contextLines);
          hit.context = lines.slice(ctxStart, ctxEnd + 1);
          hit.context_start_line = chunk.start_line + ctxStart;
        }
      }
      hits.push(hit);
    }
  }

  const result: LiteralLocateResult = {
    literal: label,
    mode,
    n,
    files: fileSet.size,
    truncated: mode !== "count" && limit != null && n > hits.length,
    hits: mode === "count" ? [] : hits,
  };
  if (needles.length > 1) {
    result.literals = needles;
  }
  return result;
}

/** Compact agent-facing JSON (minimal keys). */
export function formatLiteralLocate(result: LiteralLocateResult): Record<string, unknown> {
  const base: Record<string, unknown> = {
    literal: result.literal,
    mode: result.mode,
    n: result.n,
    files: result.files,
  };
  if (result.literals) {
    base.literals = result.literals;
  }

  if (result.mode === "count") {
    return base;
  }

  if (result.truncated) {
    base.truncated = true;
  }
  base.hits = result.hits.map((hit) => {
    const h: Record<string, unknown> = { f: hit.file_path, l: hit.line };
    if (hit.text !== undefined) {
      h.t = hit.text;
    }
    if (hit.context !== undefined) {
      h.ctx = hit.context;
      h.ctx_l = hit.context_start_line;
    }
    return h;
  });
  return base;
}
