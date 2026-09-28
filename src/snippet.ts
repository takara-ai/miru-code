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

export function resolveSupportingSnippetLines(): number {
  return envOptionalInt(["MIRU_SUPPORTING_SNIPPET_LINES"], 3) ?? 12;
}

/** Keep normal best hits complete; outline only unusually large implementations. */
export function resolvePrimarySnippetMaxLines(): number {
  return envOptionalInt(["MIRU_PRIMARY_SNIPPET_MAX_LINES"], 3) ?? 48;
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

const DECLARATION_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|type|struct|trait|impl|record|namespace|contract|library|object)\b|^\s*(?:export\s+)?(?:const|let|var)\s+[$\w]+\s*=\s*[{[(]|^\s*(?:async\s+)?def\s+\w+|^\s*def\s+\w+|^\s*fn\s+\w+|^\s*func\s+\w+|^\s*defmodule\b|^\s*def\w*\b|^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|partial|unsafe|extern)\s+)+(?:[A-Za-z_$][\w:<>[\]?.,\s]*\s+)+[A-Za-z_$]\w*\s*\(|^\s*(?:void|bool|boolean|char|short|int|long|float|double|string|[A-Z][\w:<>[\]?.,]*)\s+[A-Za-z_$]\w*\s*\(|^\s*(?:function\s+)?[A-Za-z_]\w*\s*\(\)\s*\{/;
const BRACE_BODY_RE =
  /\b(?:function|class|interface|enum|struct|trait|impl|record|namespace|contract|library|object|fn|func)\b|=\s*[{[(]|[A-Za-z_$]\w*\s*\([^)]*\)\s*\{/;
const RUBY_OR_ELIXIR_BODY_RE = /^\s*def\w*\b|^\s*defmodule\b/;
const MAX_DECLARATION_LOOKBACK = 40;
const INDENTED_BLOCK_LANGUAGES = new Set(["python", "haskell", "ocaml"]);
const END_BLOCK_LANGUAGES = new Set(["ruby", "elixir"]);
const TAG_LANGUAGES = new Set(["html", "embeddedtemplate", "xml", "vue", "svelte"]);
const BRACE_BLOCK_LANGUAGES = new Set([
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "java",
  "javascript",
  "json",
  "kotlin",
  "php",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
]);
const HTML_TAG_RE = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function withoutStrings(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function completeIndentedBlock(lines: string[], start: number, end: number): [number, number] {
  const baseIndent = indentation(lines[start] ?? "");
  for (let i = Math.max(start + 1, end); i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() && indentation(line) <= baseIndent) {
      return [start, i];
    }
  }
  return [start, lines.length];
}

function isIndentedDeclaration(line: string, language: string | null): boolean {
  if (language === "python") {
    return /^\s*(?:async\s+)?(?:def|class)\b/.test(line);
  }
  if (language === "haskell") {
    return /^\s*[A-Za-z_][\w']*\b.*=/.test(line);
  }
  return /^\s*(?:let|type|module)\b/.test(line);
}

function isEndBlockOpen(line: string, language: string | null): boolean {
  const trimmed = line.trimStart();
  if (language === "ruby") {
    return (
      /^(?:def|class|module|if|unless|case|begin|while|until|for)\b/.test(trimmed) ||
      /\bdo\b/.test(trimmed)
    );
  }
  return (
    /^(?:def\w*|defmodule|if|unless|case|cond|receive|try|for|with)\b/.test(trimmed) ||
    /\b(?:do|fn)\b/.test(trimmed)
  );
}

function completeEndBlock(
  lines: string[],
  start: number,
  end: number,
  language: string | null,
): [number, number] {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = withoutStrings(lines[i] ?? "");
    if (isEndBlockOpen(line, language)) {
      depth++;
    }
    if (/^\s*end\b/.test(line)) {
      depth--;
    }
    if (i + 1 >= end && depth <= 0) {
      return [start, i + 1];
    }
  }
  return [start, lines.length];
}

function completeHtmlTag(
  lines: string[],
  start: number,
  end: number,
  anchor: number,
): [number, number] {
  const openTags: Array<{ name: string; start: number }> = [];
  for (let i = Math.max(0, start - MAX_DECLARATION_LOOKBACK); i <= anchor; i++) {
    const line = lines[i] ?? "";
    for (const match of line.matchAll(HTML_TAG_RE)) {
      const name = match[1]?.toLowerCase();
      if (!name) {
        continue;
      }
      if (match[0].startsWith("</")) {
        for (let j = openTags.length - 1; j >= 0; j--) {
          if (openTags[j]?.name === name) {
            openTags.splice(j, 1);
            break;
          }
        }
      } else if (!match[0].endsWith("/>") && !HTML_VOID_TAGS.has(name)) {
        openTags.push({ name, start: i });
      }
    }
  }
  const container = openTags.at(-1);
  if (!container) {
    return [start, end];
  }
  const closeTag = new RegExp(`</${container.name}\\s*>`, "i");
  for (let i = Math.max(end - 1, container.start); i < lines.length; i++) {
    if (closeTag.test(lines[i] ?? "")) {
      return [container.start, i + 1];
    }
  }
  return [container.start, lines.length];
}

/**
 * Keep a query-centred snippet readable without relying on a parser at response time.
 *
 * Chunks are already AST-derived when a grammar is available. This final guard avoids
 * cutting through the declaration/object that contains the selected line: it moves the
 * start to a nearby declaration and extends the end through its closing delimiter.
 * Unknown syntaxes retain the original fixed window.
 */
function completeStructure(
  lines: string[],
  start: number,
  end: number,
  anchor: number,
  language: string | null,
): [number, number] {
  if (TAG_LANGUAGES.has(language ?? "")) {
    return completeHtmlTag(lines, start, end, anchor);
  }
  let structuralStart = start;
  const lookback = Math.max(0, anchor - MAX_DECLARATION_LOOKBACK);
  let foundDeclaration = false;
  for (let i = anchor; i >= lookback; i--) {
    const line = lines[i] ?? "";
    if (DECLARATION_RE.test(line)) {
      structuralStart = i;
      foundDeclaration = true;
      break;
    }
    // Include a doc block only when the candidate already begins inside it.
    if (line.trimStart().startsWith("/**")) {
      structuralStart = i;
      break;
    }
  }

  if (!foundDeclaration && BRACE_BLOCK_LANGUAGES.has(language ?? "")) {
    for (let i = anchor; i >= lookback; i--) {
      if ((lines[i] ?? "").includes("{")) {
        structuralStart = i;
        break;
      }
    }
  }

  const declaration = lines[structuralStart] ?? "";
  if (
    INDENTED_BLOCK_LANGUAGES.has(language ?? "") &&
    isIndentedDeclaration(declaration, language)
  ) {
    return completeIndentedBlock(lines, structuralStart, end);
  }
  if (END_BLOCK_LANGUAGES.has(language ?? "") && RUBY_OR_ELIXIR_BODY_RE.test(declaration)) {
    return completeEndBlock(lines, structuralStart, end, language);
  }
  const braceBody = BRACE_BODY_RE.test(declaration);
  const rubyOrElixirBody = RUBY_OR_ELIXIR_BODY_RE.test(declaration);
  let braces = 0;
  let parens = 0;
  let blockComment = false;
  let sawBraceBody = false;
  let rubyEnds = 0;

  for (let i = structuralStart; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = withoutStrings(raw);
    if (line.includes("/*")) {
      blockComment = true;
    }
    if (line.includes("*/")) {
      blockComment = false;
    }
    braces += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    parens += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (line.includes("{")) {
      sawBraceBody = true;
    }
    if (rubyOrElixirBody && /^\s*end\b/.test(line)) {
      rubyEnds++;
    }

    if (i + 1 < end) {
      continue;
    }
    if (blockComment || parens > 0) {
      continue;
    }
    if (rubyOrElixirBody) {
      if (rubyEnds > 0) {
        return [structuralStart, i + 1];
      }
      continue;
    }
    if (braceBody && (!sawBraceBody || braces > 0)) {
      continue;
    }
    // A non-declaration snippet is still made safe if its window opened a block.
    if (!braceBody && braces > 0) {
      continue;
    }
    return [structuralStart, i + 1];
  }

  return [structuralStart, lines.length];
}

/**
 * Turn a long supporting hit into an explicit outline instead of emitting a
 * syntactically broken fragment. The best hit remains complete; this is only
 * for lower-ranked context that helps navigation but rarely needs a full body.
 */
function compactSupportingSnippet(snippet: SnippetResult, maxLines: number): SnippetResult {
  const lines = snippet.chunk.content.split("\n");
  if (lines.length <= maxLines) {
    return snippet;
  }

  const declarationIndex = lines.findIndex((line) => DECLARATION_RE.test(line));
  const anchorOffset = Math.max(
    0,
    Math.min(lines.length - 1, snippet.meta.anchor_line - snippet.chunk.start_line),
  );
  const declaration =
    declarationIndex >= 0
      ? lines
          .slice(declarationIndex, Math.min(lines.length, declarationIndex + 4))
          .join("\n")
          .trim()
      : null;
  const anchor = (lines[anchorOffset] ?? "").trim();
  const outline = [
    "[Supporting context — complete outline]",
    declaration ? `Symbol:\n${declaration}` : null,
    anchor ? `Matched line ${snippet.meta.anchor_line}: ${anchor}` : null,
    "Implementation omitted; call expand only if you need its full body.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    chunk: {
      ...snippet.chunk,
      content: outline,
    },
    meta: {
      ...snippet.meta,
      truncated: true,
    },
  };
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
  anchorLine?: number,
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

  const queryAnchorOffset = anchorLineOffset(chunk.content, query);
  const anchorOffset =
    anchorLine == null
      ? queryAnchorOffset
      : Math.max(0, Math.min(lines.length - 1, anchorLine - chunk.start_line));
  const requestedStart = Math.max(0, anchorOffset - linesEachSide);
  const requestedEnd = Math.min(lines.length, anchorOffset + linesEachSide + 1);
  const [startOffset, endOffset] = completeStructure(
    lines,
    requestedStart,
    requestedEnd,
    anchorOffset,
    chunk.language,
  );
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
  sourceChunks?: ReadonlyMap<string, Chunk>,
): Array<{ result: SearchResult; meta: SnippetMeta }> {
  const radius = linesEachSide ?? resolveSnippetLines();
  const supportingMaxLines = resolveSupportingSnippetLines();
  const primaryMaxLines = resolvePrimarySnippetMaxLines();
  const contextualResults = results.map((result) => {
    const source = sourceChunks?.get(result.chunk.file_path);
    return {
      result: source ? { ...result, chunk: source } : result,
      // Select the anchor from the ranked chunk, not from the full source file.
      // The same query may occur elsewhere in that file.
      anchorLine: result.chunk.start_line + anchorLineOffset(result.chunk.content, query),
    };
  });
  return contextualResults.map(({ result, anchorLine }, rank) => {
    const { chunk, meta } = trimChunkToSnippet(result.chunk, query, radius, anchorLine);
    const snippet = compactSupportingSnippet(
      { chunk, meta },
      rank === 0 ? primaryMaxLines : supportingMaxLines,
    );
    return { result: { chunk: snippet.chunk, score: result.score }, meta: snippet.meta };
  });
}

export {
  countTokens,
  estimateResultTokens,
  tokenCountMethod,
  tokenizerJsonPath,
} from "./token-count.ts";
