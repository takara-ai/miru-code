import type { EmbeddingBackend } from "./embeddings/openai.ts";
import type { BM25Index } from "./index/bm25.ts";
import type { SemanticIndex } from "./index/semantic-index.ts";
import { selectorToMask } from "./index/sparse.ts";
import { selectTopKScoreIndices } from "./index/topk.ts";
import { applyQueryBoost, boostMultiChunkFiles, isSymbolQuery } from "./ranking/boosting.ts";
import { rankingConfig } from "./ranking/config.ts";
import { searchImprovementsEnabled } from "./ranking/features.ts";
import { isLocationQuery } from "./ranking/location.ts";
import { rerankTopk } from "./ranking/penalties.ts";
import { resolveAlpha } from "./ranking/weighting.ts";
import { tokenize } from "./tokens.ts";
import type { Chunk, SearchResult } from "./types.ts";
import { chunkKey } from "./types.ts";

function rrfScores(scores: Map<string, number>, rrfK: number): Map<string, number> {
  if (scores.size === 0) {
    return scores;
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map<string, number>();
  ranked.forEach(([key], i) => {
    out.set(key, 1.0 / (rrfK + i + 1));
  });
  return out;
}

/** Put each retriever on [0, 1] while preserving gaps between candidate scores. */
export function normalizeScores(
  scores: Map<string, number>,
  mode: "minmax" | "max" = "minmax",
): Map<string, number> {
  if (scores.size === 0) return scores;
  let min = Infinity;
  let max = -Infinity;
  for (const score of scores.values()) {
    min = Math.min(min, score);
    max = Math.max(max, score);
  }
  if (mode === "max") {
    return new Map(
      [...scores].map(([key, score]) => [key, max > 0 ? Math.max(0, score) / max : 0]),
    );
  }
  const range = max - min;
  return new Map(
    [...scores].map(([key, score]) => [key, range > 0 ? (score - min) / range : max > 0 ? 1 : 0]),
  );
}

function sortTopK(arr: number[], topK: number): number[] {
  return selectTopKScoreIndices(arr, topK);
}

function semanticFromQueryVector(
  queryVec: Float32Array,
  semanticIndex: SemanticIndex,
  chunks: Chunk[],
  topK: number,
  selector?: readonly number[],
): SearchResult[] {
  const { indices, distances } = semanticIndex.query(queryVec, topK, selector);
  return indices.flatMap((index, i) => {
    const chunk = chunks[index];
    if (!chunk) {
      return [];
    }
    return [{ chunk, score: 1.0 - (distances[i] ?? 0) }];
  });
}

async function scoreBm25(
  query: string,
  bm25Index: BM25Index,
  chunks: Chunk[],
  selector?: readonly number[],
): Promise<number[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return new Array<number>(chunks.length).fill(0);
  }
  const mask = selectorToMask(selector, chunks.length);
  return bm25Index.getScoresAsync(tokens, mask);
}

interface HybridSearchOptions {
  query: string;
  /** Reuse a caller-cached query vector when evaluating or batching searches. */
  queryVector?: Float32Array;
  embeddings: EmbeddingBackend;
  semanticIndex: SemanticIndex;
  bm25Index: BM25Index;
  chunks: Chunk[];
  topK: number;
  alpha?: number | null;
  selector?: readonly number[];
  rerank?: boolean;
}

export interface HybridCandidates {
  semanticScores: Map<string, number>;
  bm25Scores: Map<string, number>;
  chunksByKey: Map<string, Chunk>;
}

/** Retrieve once; calibration can reuse the exact production candidate scores. */
export async function prepareHybridCandidates(
  options: HybridSearchOptions,
): Promise<HybridCandidates> {
  const { query, queryVector, embeddings, semanticIndex, bm25Index, chunks, topK, selector } =
    options;

  const chunksByKey = new Map(chunks.map((c) => [chunkKey(c), c]));
  const semanticScores = new Map<string, number>();
  const bm25Scores = new Map<string, number>();

  if (selector?.length === 0) {
    return { semanticScores, bm25Scores, chunksByKey };
  }

  const tuning = rankingConfig();
  const candidateCount =
    searchImprovementsEnabled() && isLocationQuery(query)
      ? topK * tuning.locationCandidateMultiplier
      : topK * tuning.candidateMultiplier;

  const queryVecPromise = queryVector ? Promise.resolve(queryVector) : embeddings.embedQuery(query);
  const bm25Promise = scoreBm25(query, bm25Index, chunks, selector);
  const queryVec = await queryVecPromise;
  const lexicalScores = await bm25Promise;
  const semantic = semanticFromQueryVector(
    queryVec,
    semanticIndex,
    chunks,
    candidateCount,
    selector,
  );

  for (const r of semantic) {
    semanticScores.set(chunkKey(r.chunk), r.score);
  }

  const lexicalIndices = sortTopK(lexicalScores, candidateCount).filter(
    (i) => chunks[i] !== undefined && (lexicalScores[i] ?? 0) > 0,
  );
  for (const i of lexicalIndices) {
    bm25Scores.set(chunkKey(chunks[i] as Chunk), lexicalScores[i] as number);
  }

  if (tuning.fusion === "linear") {
    // A retrieval cutoff means "not retrieved", not "score is zero". Score both
    // modalities over the union before normalization, including lexical zeros.
    const semanticKeys = new Set(semanticScores.keys());
    const missingSemantic = lexicalIndices.filter(
      (i) => !semanticKeys.has(chunkKey(chunks[i] as Chunk)),
    );
    if (missingSemantic.length) {
      for (const r of semanticFromQueryVector(
        queryVec,
        semanticIndex,
        chunks,
        missingSemantic.length,
        missingSemantic,
      )) {
        semanticScores.set(chunkKey(r.chunk), r.score);
      }
    }
    const candidateKeys = new Set([...semanticScores.keys(), ...bm25Scores.keys()]);
    for (let i = 0; i < chunks.length; i++) {
      const key = chunkKey(chunks[i] as Chunk);
      if (candidateKeys.has(key)) bm25Scores.set(key, lexicalScores[i] ?? 0);
    }
  }

  return { semanticScores, bm25Scores, chunksByKey };
}

/** Same fusion and post-fusion ranking for live search and cached calibration. */
export function rankHybridCandidates(
  candidates: HybridCandidates,
  options: Pick<HybridSearchOptions, "query" | "chunks" | "topK" | "alpha" | "rerank">,
): SearchResult[] {
  const { semanticScores, bm25Scores, chunksByKey } = candidates;
  const { query, chunks, topK, alpha, rerank = true } = options;
  const alphaWeight = resolveAlpha(query, alpha);
  const tuning = rankingConfig();

  const normalize =
    tuning.fusion === "rrf"
      ? (scores: Map<string, number>) => rrfScores(scores, tuning.rrfK)
      : (scores: Map<string, number>) => normalizeScores(scores, tuning.linearNormalization);
  const normalizedSemantic = normalize(semanticScores);
  const normalizedBm25 = normalize(bm25Scores);

  const allKeys = new Set([...normalizedSemantic.keys(), ...normalizedBm25.keys()]);
  const sortedKeys = [...allKeys].sort((a, b) => {
    // Every score key was produced from a chunk in this query.
    const ca = chunksByKey.get(a) as Chunk;
    const cb = chunksByKey.get(b) as Chunk;
    return ca.start_line - cb.start_line;
  });

  const combinedScores = new Map<string, number>();
  for (const key of sortedKeys) {
    combinedScores.set(
      key,
      alphaWeight * (normalizedSemantic.get(key) ?? 0) +
        (1 - alphaWeight) * (normalizedBm25.get(key) ?? 0),
    );
  }

  if (rerank) {
    // Calibration targets conceptual search. Preserve explicit symbol/location
    // navigation signals, which need a separate representative calibration set.
    const scale =
      tuning.fusion === "linear" && !isSymbolQuery(query) && !isLocationQuery(query)
        ? tuning.linearQueryBoostScale
        : 1;
    if (scale > 0) {
      const before = scale < 1 ? new Map(combinedScores) : null;
      boostMultiChunkFiles(combinedScores, chunksByKey);
      applyQueryBoost(combinedScores, query, chunks, chunksByKey);
      if (before) {
        for (const [key, boosted] of combinedScores) {
          const base = before.get(key) ?? 0;
          combinedScores.set(key, base + scale * (boosted - base));
        }
      }
    }
    const ranked = rerankTopk(combinedScores, chunksByKey, topK, alphaWeight < 1.0);
    return ranked.map(([chunk, score]) => ({ chunk, score }));
  }

  return [...combinedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([key, score]) => ({ chunk: chunksByKey.get(key) as Chunk, score }));
}

export async function hybridSearch(options: HybridSearchOptions): Promise<SearchResult[]> {
  const candidates = await prepareHybridCandidates(options);
  return rankHybridCandidates(candidates, options);
}

export async function searchSemanticOnly(options: {
  query: string;
  embeddings: EmbeddingBackend;
  semanticIndex: SemanticIndex;
  chunks: Chunk[];
  topK: number;
  selector?: readonly number[];
}): Promise<SearchResult[]> {
  const queryVec = await options.embeddings.embedQuery(options.query);
  return semanticFromQueryVector(
    queryVec,
    options.semanticIndex,
    options.chunks,
    options.topK,
    options.selector,
  );
}
