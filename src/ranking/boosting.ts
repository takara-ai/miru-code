import { basename, dirname } from "node:path";
import { splitIdentifier } from "../tokens.ts";
import type { Chunk } from "../types.ts";
import { chunkKey } from "../types.ts";

const SYMBOL_QUERY_RE =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\\|->|\.)[A-Za-z_][A-Za-z0-9_]*)+)|_(?:[A-Za-z0-9_]*)|(?:[A-Za-z][A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*)|(?:[A-Z][A-Za-z0-9]*))$/;

const EMBEDDED_SYMBOL_RE =
  /\b(?:[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+)\b/g;

const EMBEDDED_STEM_MIN_LEN = 4;
const EMBEDDED_SYMBOL_BOOST_SCALE = 0.5;

const DEFINITION_KEYWORDS = [
  "class",
  "module",
  "defmodule",
  "def",
  "interface",
  "struct",
  "enum",
  "trait",
  "type",
  "func",
  "function",
  "object",
  "abstract class",
  "data class",
  "fn",
  "fun",
  "package",
  "namespace",
  "protocol",
  "record",
  "typedef",
];

const SQL_DEFINITION_KEYWORDS = [
  "CREATE TABLE",
  "CREATE VIEW",
  "CREATE PROCEDURE",
  "CREATE FUNCTION",
];

const DEFINITION_BOOST_MULTIPLIER = 3.0;
const STEM_BOOST_MULTIPLIER = 1.0;
const FILE_COHERENCE_BOOST_FRAC = 0.2;

const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with".split(
    " ",
  ),
);

const definitionPatternCache = new Map<string, [RegExp, RegExp]>();

function definitionPatterns(symbolName: string): [RegExp, RegExp] {
  let cached = definitionPatternCache.get(symbolName);
  if (cached) {
    return cached;
  }
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nsPrefix = "(?:[A-Za-z_][A-Za-z0-9_]*(?:\\.|::))*";
  const suffix = `)\\s+${nsPrefix}${escaped}(?:\\s|[<({:\\[;]|$)`;
  const keywordBody = DEFINITION_KEYWORDS.map((k) => k.replace(/ /g, "\\s+")).join("|");
  const sqlBody = SQL_DEFINITION_KEYWORDS.join("|");
  const keywordPrefix = "(?:^|(?<=\\s))(?:";
  cached = [
    new RegExp(keywordPrefix + keywordBody + suffix, "m"),
    new RegExp(keywordPrefix + sqlBody + suffix, "im"),
  ];
  definitionPatternCache.set(symbolName, cached);
  return cached;
}

function chunkDefinesSymbol(chunk: Chunk, symbolName: string): boolean {
  const [general, sql] = definitionPatterns(symbolName);
  return general.test(chunk.content) || sql.test(chunk.content);
}

function stemMatches(stem: string, name: string): boolean {
  const stemNorm = stem.replace(/_/g, "");
  return (
    stem === name ||
    stemNorm === name ||
    stem.replace(/s$/, "") === name ||
    stemNorm.replace(/s$/, "") === name
  );
}

export function isSymbolQuery(query: string): boolean {
  return SYMBOL_QUERY_RE.test(query.trim());
}

function extractSymbolName(query: string): string {
  for (const sep of ["::", "\\", "->", "."]) {
    if (query.includes(sep)) {
      return query.split(sep).pop()?.trim() ?? query.trim();
    }
  }
  return query.trim();
}

function definitionTier(chunk: Chunk, names: Set<string>, boostUnit: number): number {
  if (![...names].some((n) => chunkDefinesSymbol(chunk, n))) {
    return 0;
  }
  const stem = basename(chunk.file_path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  return boostUnit * ([...names].some((n) => stemMatches(stem, n.toLowerCase())) ? 1.5 : 1.0);
}

export function boostMultiChunkFiles(
  scores: Map<string, number>,
  chunksByKey: Map<string, Chunk>,
): void {
  if (scores.size === 0) {
    return;
  }
  const maxScore = Math.max(...scores.values());
  if (maxScore === 0) {
    return;
  }

  const fileSum = new Map<string, number>();
  const bestChunk = new Map<string, string>();

  for (const [key, score] of scores) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    const fp = chunk.file_path;
    fileSum.set(fp, (fileSum.get(fp) ?? 0) + score);
    const best = bestChunk.get(fp);
    if (!best || score > (scores.get(best) ?? 0)) {
      bestChunk.set(fp, key);
    }
  }

  const maxFileSum = Math.max(...fileSum.values());
  const boostUnit = maxScore * FILE_COHERENCE_BOOST_FRAC;

  for (const [fp, key] of bestChunk) {
    const current = scores.get(key) ?? 0;
    scores.set(key, current + boostUnit * ((fileSum.get(fp) ?? 0) / maxFileSum));
  }
}

export function applyQueryBoost(
  combinedScores: Map<string, number>,
  query: string,
  allChunks: Chunk[],
  chunksByKey: Map<string, Chunk>,
): Map<string, number> {
  if (combinedScores.size === 0) {
    return combinedScores;
  }

  const maxScore = Math.max(...combinedScores.values());
  if (isSymbolQuery(query)) {
    boostSymbolDefinitions(combinedScores, query, maxScore, allChunks, chunksByKey);
  } else {
    boostStemMatches(combinedScores, query, maxScore, chunksByKey);
    boostEmbeddedSymbols(combinedScores, query, maxScore, allChunks, chunksByKey);
  }
  return combinedScores;
}

function boostSymbolDefinitions(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  allChunks: Chunk[],
  chunksByKey: Map<string, Chunk>,
): void {
  const symbolName = extractSymbolName(query);
  const names = new Set([symbolName]);
  if (symbolName !== query.trim()) {
    names.add(query.trim());
  }
  const boostUnit = maxScore * DEFINITION_BOOST_MULTIPLIER;

  for (const key of [...boosted.keys()]) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier) {
      boosted.set(key, (boosted.get(key) ?? 0) + tier);
    }
  }

  for (const chunk of allChunks) {
    const key = chunkKey(chunk);
    if (boosted.has(key)) {
      continue;
    }
    const stem = basename(chunk.file_path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    if (![...names].some((n) => stemMatches(stem, n.toLowerCase()))) {
      continue;
    }
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier) {
      boosted.set(key, tier);
    }
  }
}

function boostEmbeddedSymbols(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  allChunks: Chunk[],
  chunksByKey: Map<string, Chunk>,
): void {
  const names = new Set(query.match(EMBEDDED_SYMBOL_RE) ?? []);
  if (names.size === 0) {
    return;
  }

  const boostUnit = maxScore * DEFINITION_BOOST_MULTIPLIER * EMBEDDED_SYMBOL_BOOST_SCALE;
  const symbolsLower = new Set([...names].map((s) => s.toLowerCase()));

  for (const key of [...boosted.keys()]) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier) {
      boosted.set(key, (boosted.get(key) ?? 0) + tier);
    }
  }

  for (const chunk of allChunks) {
    const key = chunkKey(chunk);
    if (boosted.has(key)) {
      continue;
    }
    const stem = basename(chunk.file_path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    const stemNorm = stem.replace(/_/g, "");
    const ok = [...symbolsLower].some(
      (symbolLower) =>
        stem === symbolLower ||
        stemNorm === symbolLower ||
        (stem.length >= EMBEDDED_STEM_MIN_LEN && symbolLower.startsWith(stem)) ||
        (stemNorm.length >= EMBEDDED_STEM_MIN_LEN && symbolLower.startsWith(stemNorm)),
    );
    if (!ok) {
      continue;
    }
    const tier = definitionTier(chunk, names, boostUnit);
    if (tier) {
      boosted.set(key, tier);
    }
  }
}

function countKeywordMatches(keywords: Set<string>, parts: Set<string>): number {
  const exact = [...keywords].filter((k) => parts.has(k));
  if (exact.length === keywords.size) {
    return exact.length;
  }
  let nMatches = exact.length;
  for (const keyword of [...keywords].filter((k) => !parts.has(k))) {
    for (const part of parts) {
      const shorter = keyword.length <= part.length ? keyword : part;
      const longer = keyword.length <= part.length ? part : keyword;
      if (shorter.length >= 3 && longer.startsWith(shorter)) {
        nMatches++;
        break;
      }
    }
  }
  return nMatches;
}

function boostStemMatches(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  chunksByKey: Map<string, Chunk>,
): void {
  const keywords = new Set(
    (query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [])
      .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
      .map((w) => w.toLowerCase()),
  );
  if (keywords.size === 0) {
    return;
  }

  const boost = maxScore * STEM_BOOST_MULTIPLIER;
  const pathCache = new Map<string, Set<string>>();

  for (const key of [...boosted.keys()]) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    let parts = pathCache.get(chunk.file_path);
    if (!parts) {
      const stem = basename(chunk.file_path).replace(/\.[^.]+$/, "");
      parts = new Set(splitIdentifier(stem));
      const parent = basename(dirname(chunk.file_path));
      if (parent && parent !== "." && parent !== "..") {
        for (const p of splitIdentifier(parent)) {
          parts.add(p);
        }
      }
      pathCache.set(chunk.file_path, parts);
    }
    const nMatches = countKeywordMatches(keywords, parts);
    if (nMatches > 0) {
      const matchRatio = nMatches / keywords.size;
      if (matchRatio >= 0.1) {
        boosted.set(key, (boosted.get(key) ?? 0) + boost * matchRatio);
      }
    }
  }
}
