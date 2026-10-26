import { envOptionalInt } from "./env.ts";
import { tokenize } from "./tokens.ts";
import type { Chunk, SearchResult } from "./types.ts";

const SNIPPET_STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with".split(
    " ",
  ),
);

export interface SnippetMeta {
  truncated: boolean;
  anchor_line: number;
  full_start_line: number;
  full_end_line: number;
  /** Original ranked chunk's lines for a follow-up read. */
  match_start_line: number;
  match_end_line: number;
}

export interface SnippetResult {
  chunk: Chunk;
  meta: SnippetMeta;
}

export function resolveSnippetLines(): number {
  return envOptionalInt(["MIRU_SNIPPET_LINES"], 0) ?? 2;
}

export function searchSnippetsEnabled(): boolean {
  const value = process.env.MIRU_SEARCH_SNIPPETS;
  return value !== "0" && value !== "false";
}

function queryMatchTerms(query: string): Set<string> {
  const terms = new Set<string>();
  for (const tok of tokenize(query)) {
    if (tok.length >= 3 && !SNIPPET_STOPWORDS.has(tok)) {
      terms.add(tok);
    }
  }
  for (const word of query.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && !SNIPPET_STOPWORDS.has(lower)) {
      terms.add(lower);
    }
  }
  return terms;
}

function scoreLine(line: string, terms: Set<string>): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score++;
    }
  }
  return score;
}

/** Pick the 0-based line index inside content that best matches the query. */
export function anchorLineOffset(content: string, query: string): number {
  const lines = content.split("\n");
  const terms = queryMatchTerms(query);
  let bestIndex = Math.floor(lines.length / 2);
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const score = scoreLine(lines[i] ?? "", terms);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Return a bounded window of verbatim source lines, without interpreting the language. */
export function trimChunkToSnippet(
  chunk: Chunk,
  query: string,
  linesEachSide = resolveSnippetLines(),
  anchorLine?: number,
): SnippetResult {
  const lines = chunk.content.split("\n");
  const anchorOffset =
    anchorLine == null
      ? anchorLineOffset(chunk.content, query)
      : Math.max(0, Math.min(lines.length - 1, anchorLine - chunk.start_line));
  const start = Math.max(0, anchorOffset - linesEachSide);
  const end = Math.min(lines.length, anchorOffset + linesEachSide + 1);
  const truncated = start > 0 || end < lines.length;

  return {
    chunk: truncated
      ? {
          ...chunk,
          content: lines.slice(start, end).join("\n"),
          start_line: chunk.start_line + start,
          end_line: chunk.start_line + end - 1,
        }
      : chunk,
    meta: {
      truncated,
      anchor_line: chunk.start_line + anchorOffset,
      full_start_line: chunk.start_line,
      full_end_line: chunk.end_line,
      match_start_line: chunk.start_line,
      match_end_line: chunk.end_line,
    },
  };
}

export function applySnippetsToResults(
  results: SearchResult[],
  query: string,
  linesEachSide = resolveSnippetLines(),
  sourceChunks?: ReadonlyMap<string, Chunk>,
): Array<{ result: SearchResult; meta: SnippetMeta }> {
  return results.map(({ chunk: ranked, score }) => {
    // Select the anchor from the ranked chunk, even when showing wider source context.
    const anchorLine = ranked.start_line + anchorLineOffset(ranked.content, query);
    const source = sourceChunks?.get(ranked.file_path) ?? ranked;
    const snippet = trimChunkToSnippet(source, query, linesEachSide, anchorLine);
    return {
      result: { chunk: snippet.chunk, score },
      meta: {
        ...snippet.meta,
        match_start_line: ranked.start_line,
        match_end_line: ranked.end_line,
      },
    };
  });
}

export {
  countTokens,
  estimateResultTokens,
  tokenCountMethod,
  tokenizerJsonPath,
} from "./token-count.ts";
