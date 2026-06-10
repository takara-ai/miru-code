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
}

export interface SnippetResult {
  chunk: Chunk;
  meta: SnippetMeta;
}

export function resolveSnippetLines(): number {
  return envOptionalInt(["MIRU_SNIPPET_LINES"], 3) ?? 15;
}

export function searchSnippetsEnabled(): boolean {
  const value = process.env.MIRU_SEARCH_SNIPPETS;
  if (value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  return true;
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

/** Pick the 0-based line index inside `content` that best matches the query. */
export function anchorLineOffset(content: string, query: string): number {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return 0;
  }

  const terms = queryMatchTerms(query);
  let bestIndex = Math.floor(lines.length / 2);
  let bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const score = scoreLine(line, terms);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export function trimChunkToSnippet(
  chunk: Chunk,
  query: string,
  linesEachSide = resolveSnippetLines(),
): SnippetResult {
  const lines = chunk.content.split("\n");
  if (lines.length === 0) {
    return {
      chunk,
      meta: {
        truncated: false,
        anchor_line: chunk.start_line,
        full_start_line: chunk.start_line,
        full_end_line: chunk.end_line,
      },
    };
  }

  const anchorOffset = anchorLineOffset(chunk.content, query);
  const startOffset = Math.max(0, anchorOffset - linesEachSide);
  const endOffset = Math.min(lines.length, anchorOffset + linesEachSide + 1);
  const truncated = startOffset > 0 || endOffset < lines.length;

  if (!truncated) {
    return {
      chunk,
      meta: {
        truncated: false,
        anchor_line: chunk.start_line + anchorOffset,
        full_start_line: chunk.start_line,
        full_end_line: chunk.end_line,
      },
    };
  }

  const snippetContent = lines.slice(startOffset, endOffset).join("\n");
  return {
    chunk: {
      ...chunk,
      content: snippetContent,
      start_line: chunk.start_line + startOffset,
      end_line: chunk.start_line + endOffset - 1,
    },
    meta: {
      truncated: true,
      anchor_line: chunk.start_line + anchorOffset,
      full_start_line: chunk.start_line,
      full_end_line: chunk.end_line,
    },
  };
}

export function applySnippetsToResults(
  results: SearchResult[],
  query: string,
  linesEachSide?: number,
): Array<{ result: SearchResult; meta: SnippetMeta }> {
  const radius = linesEachSide ?? resolveSnippetLines();
  return results.map((result) => {
    const { chunk, meta } = trimChunkToSnippet(result.chunk, query, radius);
    return { result: { chunk, score: result.score }, meta };
  });
}

export function estimateResultTokens(results: SearchResult[]): number {
  return results.reduce((sum, r) => sum + Math.floor(r.chunk.content.length / 4), 0);
}
