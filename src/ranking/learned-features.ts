import { basename } from "node:path";
import { tokenize } from "../tokens.ts";
import { type Chunk, chunkKey, type SearchResult } from "../types.ts";
import {
  chunkDefinesSymbol,
  extractSymbolName,
  isSymbolQuery,
  symbolDefinitionTier,
} from "./boosting.ts";
import { isLocationQuery } from "./location.ts";

export const RANK_FEATURE_VERSION = 2;
export const RANK_FEATURE_NAMES = [
  "semantic",
  "semantic_max",
  "semantic_minmax",
  "semantic_rr",
  "semantic_gap",
  "bm25_log",
  "bm25_max",
  "bm25_minmax",
  "bm25_rr",
  "bm25_gap",
  "legacy_rr",
  "legacy_max",
  "fusion_40_max",
  "fusion_70_minmax",
  "body_coverage",
  "body_density",
  "head_coverage",
  "path_coverage",
  "stem_coverage",
  "exact_identifier_coverage",
  "definition_coverage",
  "query_token_count",
  "query_chars_log",
  "query_symbol",
  "query_location",
  "query_test",
  "query_docs",
  "query_example",
  "body_chars_log",
  "lines_log",
  "path_depth",
  "test_path",
  "docs_path",
  "example_path",
  "legacy_path",
  "type_definition",
  "reexport_file",
  "has_definition",
  "file_candidates_log",
  "file_semantic_max",
  "file_bm25_max",
  "semantic_bm25_agreement",
  "exact_symbol_definition",
  "symbol_definition_tier",
] as const;

const STOP = new Set(
  "a an and are as at be by can could do does for from has have how i if in is it me not of on or that the their there these this to was what when where which who why with would you your".split(
    " ",
  ),
);
function tokens(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => t.length > 1 && !STOP.has(t)))];
}
const coverage = (needles: readonly string[], haystack: Set<string>) =>
  needles.length ? needles.filter((token) => haystack.has(token)).length / needles.length : 0;

const definitionMetadata = new Map<Chunk, { content: string; lower: string; present: number }>();
let definitionChars = 0;
/** Definition-only cache migration: no body/path tokenization or retrieval recomputation. */
export function buildDefinitionFeatures(query: string, chunks: readonly Chunk[]) {
  const identifiers = [...new Set(query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter(
    (word) => !STOP.has(word.toLowerCase()) && word.length > 1,
  );
  const symbol = isSymbolQuery(query);
  return chunks.map((chunk) => {
    let metadata = definitionMetadata.get(chunk);
    if (!metadata || metadata.content !== chunk.content) {
      if (metadata) {
        definitionChars -= metadata.lower.length;
        definitionMetadata.delete(chunk);
      }
      metadata = {
        content: chunk.content,
        lower: chunk.content.toLowerCase(),
        present: Number(
          /\b(?:def|function|func|fn|class|struct|interface|trait|enum|fun)\s+[A-Za-z_][A-Za-z0-9_]*/.test(
            chunk.content,
          ),
        ),
      };
      if (metadata.lower.length <= 2_000_000) {
        definitionMetadata.set(chunk, metadata);
        definitionChars += metadata.lower.length;
        while (definitionMetadata.size > 512 || definitionChars > 2_000_000) {
          const oldest = definitionMetadata.entries().next().value;
          if (!oldest) break;
          definitionChars -= oldest[1].lower.length;
          definitionMetadata.delete(oldest[0]);
        }
      }
    }
    const lower = metadata.lower;
    const tier = symbolDefinitionTier(chunk, query);
    return {
      coverage: identifiers.length
        ? identifiers.filter(
            (name) =>
              lower.includes(name.toLowerCase()) &&
              chunkDefinesSymbol(chunk, extractSymbolName(name)),
          ).length / identifiers.length
        : 0,
      present: metadata.present,
      exactSymbol: Number(symbol && tier > 0),
      tier,
    };
  });
}

// Bound parsed token metadata independently of corpus size; vectors stay int8.
export const RANK_FEATURE_CACHE_LIMIT = 512;
const MAX_TOKEN_ENTRIES = 100_000;
let cachedTokenEntries = 0;
const chunkFeatures = new Map<
  Chunk,
  {
    content: string;
    path: string;
    start: number;
    end: number;
    body: Set<string>;
    head: Set<string>;
    pathTokens: Set<string>;
    stem: Set<string>;
    identifiers: Set<string>;
    definitions: Set<string>;
    values: number[];
    tokenEntries: number;
  }
>();
export function clearRankFeatureCache(): void {
  chunkFeatures.clear();
  cachedTokenEntries = 0;
  definitionMetadata.clear();
  definitionChars = 0;
}
function staticFeatures(chunk: Chunk) {
  const cached = chunkFeatures.get(chunk);
  if (
    cached &&
    cached.content === chunk.content &&
    cached.path === chunk.file_path &&
    cached.start === chunk.start_line &&
    cached.end === chunk.end_line
  )
    return cached;
  if (cached) {
    cachedTokenEntries -= cached.tokenEntries;
    chunkFeatures.delete(chunk);
  }
  const path = chunk.file_path.replaceAll("\\", "/");
  const definitions = [
    ...chunk.content.matchAll(
      /\b(?:def|function|func|fn|class|struct|interface|trait|enum|fun)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    ),
  ].map((match) => match[1] ?? "");
  const value = {
    content: chunk.content,
    path: chunk.file_path,
    start: chunk.start_line,
    end: chunk.end_line,
    body: new Set(tokens(chunk.content)),
    head: new Set(tokens(chunk.content.split("\n").slice(0, 5).join("\n"))),
    pathTokens: new Set(tokens(path)),
    stem: new Set(tokens(basename(path).replace(/\.[^.]+$/, ""))),
    identifiers: new Set(chunk.content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
    definitions: new Set(definitions),
    tokenEntries: 0,
    values: [
      Math.log1p(chunk.content.length),
      Math.log1p(Math.max(1, chunk.end_line - chunk.start_line + 1)),
      path.split("/").length - 1,
      Number(
        /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|(?:\.test\.|\.spec\.|_test\.|^test_)/i.test(
          path,
        ),
      ),
      Number(/(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|rst|txt)$/i.test(path)),
      Number(/(?:^|\/)(?:_?examples?|demo)(?:\/|$)/i.test(path)),
      Number(/(?:^|\/)(?:compat|_compat|legacy)(?:\/|$)/i.test(path)),
      Number(/\.d\.ts$/.test(path)),
      Number(["__init__.py", "package-info.java"].includes(basename(path))),
      Number(definitions.length > 0),
    ],
  };
  value.tokenEntries =
    value.body.size +
    value.head.size +
    value.pathTokens.size +
    value.stem.size +
    value.identifiers.size +
    value.definitions.size;
  if (value.tokenEntries <= MAX_TOKEN_ENTRIES) {
    chunkFeatures.set(chunk, value);
    cachedTokenEntries += value.tokenEntries;
    while (
      chunkFeatures.size > RANK_FEATURE_CACHE_LIMIT ||
      cachedTokenEntries > MAX_TOKEN_ENTRIES
    ) {
      const oldest = chunkFeatures.entries().next().value;
      if (!oldest) break;
      cachedTokenEntries -= oldest[1].tokenEntries;
      chunkFeatures.delete(oldest[0]);
    }
  }
  return value;
}

function statistics(scores: Map<string, number>) {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] ?? 0;
  const min = sorted.at(-1)?.[1] ?? 0;
  const ranks = new Map(sorted.map(([key], i) => [key, 1 / (i + 1)]));
  return {
    max,
    min,
    ranks,
    normalized: (value: number) => (max > 0 ? Math.max(0, value) / max : 0),
    minmax: (value: number) => (max > min ? (value - min) / (max - min) : max > 0 ? 1 : 0),
  };
}

/** Shared offline/online features. No repo IDs, target paths, labels or language IDs. */
export function buildRankFeatures(
  query: string,
  semanticScores: Map<string, number>,
  bm25Scores: Map<string, number>,
  legacy: readonly SearchResult[],
): { chunks: Chunk[]; features: number[][] } {
  const semantic = statistics(semanticScores),
    lexical = statistics(bm25Scores);
  const legacyStats = statistics(new Map(legacy.map((r) => [chunkKey(r.chunk), r.score])));
  const terms = tokens(query);
  const identifiers = [...new Set(query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter(
    (word) => !STOP.has(word.toLowerCase()) && word.length > 1,
  );
  const queryValues = [
    terms.length,
    Math.log1p(query.length),
    Number(isSymbolQuery(query)),
    Number(isLocationQuery(query)),
    Number(/\b(test|tests|testing|spec)\b/i.test(query)),
    Number(/\b(docs?|documentation|readme)\b/i.test(query)),
    Number(/\b(examples?|demo)\b/i.test(query)),
  ];
  const definitions = buildDefinitionFeatures(
    query,
    legacy.map((r) => r.chunk),
  );
  const files = new Map<string, { count: number; semantic: number; bm25: number }>();
  for (const { chunk } of legacy) {
    const key = chunkKey(chunk);
    const file = files.get(chunk.file_path) ?? { count: 0, semantic: 0, bm25: 0 };
    file.count++;
    file.semantic = Math.max(file.semantic, semanticScores.get(key) ?? 0);
    file.bm25 = Math.max(file.bm25, bm25Scores.get(key) ?? 0);
    files.set(chunk.file_path, file);
  }
  const features = legacy.map(({ chunk }, i) => {
    const key = chunkKey(chunk);
    const doc = staticFeatures(chunk),
      body = doc.body;
    const s = semanticScores.get(key) ?? 0,
      b = bm25Scores.get(key) ?? 0;
    const sn = semantic.normalized(s),
      bn = lexical.normalized(b);
    const file = files.get(chunk.file_path);
    const row = [
      s,
      sn,
      semantic.minmax(s),
      semantic.ranks.get(key) ?? 0,
      semantic.max - s,
      Math.log1p(Math.max(0, b)),
      bn,
      lexical.minmax(b),
      lexical.ranks.get(key) ?? 0,
      lexical.max - b,
      1 / (i + 1),
      legacyStats.normalized(legacy[i]?.score ?? 0),
      0.4 * sn + 0.6 * bn,
      0.7 * semantic.minmax(s) + 0.3 * lexical.minmax(b),
      coverage(terms, body),
      body.size ? terms.filter((t) => body.has(t)).length / body.size : 0,
      coverage(terms, doc.head),
      coverage(terms, doc.pathTokens),
      coverage(terms, doc.stem),
      coverage(identifiers, doc.identifiers),
      definitions[i]?.coverage ?? 0,
      ...queryValues,
      ...doc.values,
      Math.log1p(file?.count ?? 0),
      file?.semantic ?? 0,
      lexical.normalized(file?.bm25 ?? 0),
      1 - Math.abs(sn - bn),
      definitions[i]?.exactSymbol ?? 0,
      definitions[i]?.tier ?? 0,
    ];
    if (row.length !== RANK_FEATURE_NAMES.length || row.some((value) => !Number.isFinite(value)))
      throw new Error("Invalid learned ranking features");
    // Match the persisted training matrix at numeric split boundaries.
    return row.map(Math.fround);
  });
  return { chunks: legacy.map((r) => r.chunk), features };
}
