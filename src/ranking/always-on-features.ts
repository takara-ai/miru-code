import { basename } from "node:path";
import { type Chunk, chunkKey, type SearchResult } from "../types.ts";
import { rankingConfig } from "./config.ts";
import { ChunkFeatureCache } from "./feature-cache.ts";
import { buildRankFeatures, RANK_FEATURE_NAMES } from "./learned-features.ts";

export const ALWAYS_ON_FEATURE_VERSION = 3;
export const ALWAYS_ON_FEATURE_NAMES = [
  ...RANK_FEATURE_NAMES,
  "boosted_prior",
  "boosted_prior_rr",
  "boosted_prior_gap",
  "boosted_prior_margin",
  "unicode_body_coverage",
  "unicode_head_coverage",
  "unicode_path_coverage",
  "unicode_stem_coverage",
  "unicode_definition_coverage",
  "unicode_query_terms_log",
  "non_ascii_letter_fraction",
  "unicode_body_density",
  "semantic_present",
  "bm25_positive",
  "unicode_exact_identifier",
  "unicode_definition_count_log",
] as const;

interface Metadata {
  content: string;
  path: string;
  body: Set<string>;
  head: Set<string>;
  pathTerms: Set<string>;
  stem: Set<string>;
  definitions: Set<string>;
  identifiers: Set<string>;
  entries: number;
}
const metadata = new ChunkFeatureCache<Metadata>();

/** Language-independent word boundaries; no English stopword list. */
export function unicodeRankTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize("NFKC")
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ];
}
const overlap = (terms: readonly string[], present: Set<string>) =>
  terms.length ? terms.filter((t) => present.has(t)).length / terms.length : 0;

function describe(chunk: Chunk): Metadata {
  const cached = metadata.get(chunk);
  if (cached?.content === chunk.content && cached.path === chunk.file_path) return cached;
  if (cached) metadata.delete(chunk);
  const definitions = [
    ...chunk.content.matchAll(
      /(?:^|[^\p{L}\p{N}_])(?:def|function|func|fn|class|struct|interface|trait|enum|fun|let|const|type|lemma|theorem|structure|inductive|namespace)\s+([\p{L}_][\p{L}\p{N}_]*)/gu,
    ),
  ].map((m) => m[1] ?? "");
  const value: Metadata = {
    content: chunk.content,
    path: chunk.file_path,
    body: new Set(unicodeRankTerms(chunk.content)),
    head: new Set(unicodeRankTerms(chunk.content.split("\n").slice(0, 5).join("\n"))),
    pathTerms: new Set(unicodeRankTerms(chunk.file_path)),
    stem: new Set(unicodeRankTerms(basename(chunk.file_path).replace(/\.[^.]+$/, ""))),
    definitions: new Set(definitions.flatMap(unicodeRankTerms)),
    identifiers: new Set(
      (chunk.content.normalize("NFKC").match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []).map((s) =>
        s.toLowerCase(),
      ),
    ),
    entries: 0,
  };
  value.entries =
    value.body.size +
    value.head.size +
    value.pathTerms.size +
    value.stem.size +
    value.definitions.size +
    value.identifiers.size;
  metadata.set(chunk, value, value.entries);
  return value;
}

export function clearAlwaysOnFeatureCache(): void {
  metadata.clear();
}

/** Preserve the boosted production prior; file diversity is applied after scoring. */
export function restoredPrior(prior: readonly SearchResult[]): Map<string, number> {
  const scores = new Map<string, number>(),
    counts = new Map<string, number>();
  for (const { chunk, score } of prior) {
    const n = counts.get(chunk.file_path) ?? 0;
    counts.set(chunk.file_path, n + 1);
    scores.set(chunkKey(chunk), score / rankingConfig().fileSaturationDecay ** n);
  }
  const maximum = Math.max(0, ...scores.values());
  return new Map(
    [...scores].map(([key, value]) => [key, Math.fround(maximum ? (3 * value) / maximum : 0)]),
  );
}

/** Shared training/serving features. Query properties are inputs, never routing gates. */
export function buildAlwaysOnRankFeatures(
  query: string,
  semantic: Map<string, number>,
  bm25: Map<string, number>,
  prior: readonly SearchResult[],
  legacy: readonly SearchResult[],
) {
  const built = buildRankFeatures(query, semantic, bm25, legacy);
  const scores = restoredPrior(prior);
  const ordered = [...scores].sort((a, b) => b[1] - a[1]);
  const ranks = new Map(ordered.map(([key], i) => [key, 1 / (i + 1)]));
  const margin = (ordered[0]?.[1] ?? 0) - (ordered[1]?.[1] ?? 0);
  const terms = unicodeRankTerms(query);
  const identifiers = [
    ...new Set(
      (query.normalize("NFKC").match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []).map((s) => s.toLowerCase()),
    ),
  ];
  const letters = [...query].filter((c) => /\p{L}/u.test(c));
  const nonAscii = letters.length
    ? letters.filter((c) => (c.codePointAt(0) ?? 0) > 127).length / letters.length
    : 0;
  const features = built.chunks.map((chunk, i) => {
    const key = chunkKey(chunk),
      doc = describe(chunk),
      score = scores.get(key) ?? 0;
    const row = [
      ...(built.features[i] ?? []),
      score,
      ranks.get(key) ?? 0,
      3 - score,
      margin,
      overlap(terms, doc.body),
      overlap(terms, doc.head),
      overlap(terms, doc.pathTerms),
      overlap(terms, doc.stem),
      overlap(terms, doc.definitions),
      Math.log1p(terms.length),
      nonAscii,
      doc.body.size ? terms.filter((t) => doc.body.has(t)).length / doc.body.size : 0,
      Number(semantic.has(key)),
      Number((bm25.get(key) ?? 0) > 0),
      overlap(identifiers, doc.identifiers),
      Math.log1p(doc.definitions.size),
    ];
    if (row.length !== ALWAYS_ON_FEATURE_NAMES.length || row.some((v) => !Number.isFinite(v)))
      throw Error("Invalid always-on features");
    return row.map(Math.fround);
  });
  return { chunks: built.chunks, features, prior: scores };
}
