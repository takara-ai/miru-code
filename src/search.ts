import type { EmbeddingBackend } from "./embeddings/openai.ts";
import type { BM25Index } from "./index/bm25.ts";
import type { SemanticIndex } from "./index/semantic-index.ts";
import { selectorToMask } from "./index/sparse.ts";
import { selectTopKScoreIndices } from "./index/topk.ts";
import { applyQueryBoost, boostMultiChunkFiles } from "./ranking/boosting.ts";
import { searchImprovementsEnabled } from "./ranking/features.ts";
import { isLocationQuery } from "./ranking/location.ts";
import { rerankTopk } from "./ranking/penalties.ts";
import { resolveAlpha } from "./ranking/weighting.ts";
import { tokenize } from "./tokens.ts";
import type { Chunk, SearchResult } from "./types.ts";
import { chunkKey } from "./types.ts";

const RRF_K = 60;

function rrfScores(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) {
    return scores;
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map<string, number>();
  ranked.forEach(([key], i) => {
    out.set(key, 1.0 / (RRF_K + i + 1));
  });
  return out;
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

async function searchBm25(
  query: string,
  bm25Index: BM25Index,
  chunks: Chunk[],
  topK: number,
  selector?: readonly number[],
): Promise<SearchResult[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  const mask = selectorToMask(selector, chunks.length);
  const scores = await bm25Index.getScoresAsync(tokens, mask);
  const indices = sortTopK(scores, topK);
  return indices.flatMap((i) => {
    const score = scores[i];
    const chunk = chunks[i];
    if (score === undefined || chunk === undefined || score <= 0) {
      return [];
    }
    return [{ chunk, score }];
  });
}

export async function hybridSearch(options: {
  query: string;
  embeddings: EmbeddingBackend;
  semanticIndex: SemanticIndex;
  bm25Index: BM25Index;
  chunks: Chunk[];
  topK: number;
  alpha?: number | null;
  selector?: readonly number[];
  rerank?: boolean;
}): Promise<SearchResult[]> {
  const {
    query,
    embeddings,
    semanticIndex,
    bm25Index,
    chunks,
    topK,
    alpha,
    selector,
    rerank = true,
  } = options;

  const alphaWeight = resolveAlpha(query, alpha);
  const candidateCount =
    searchImprovementsEnabled() && isLocationQuery(query) ? topK * 10 : topK * 5;
  const chunksByKey = new Map(chunks.map((c) => [chunkKey(c), c]));

  const queryVecPromise = embeddings.embedQuery(query);
  const bm25Promise = searchBm25(query, bm25Index, chunks, candidateCount, selector);
  const queryVec = await queryVecPromise;
  const bm25Hits = await bm25Promise;
  const semantic = semanticFromQueryVector(
    queryVec,
    semanticIndex,
    chunks,
    candidateCount,
    selector,
  );

  const semanticScores = new Map<string, number>();
  for (const r of semantic) {
    semanticScores.set(chunkKey(r.chunk), r.score);
  }

  const bm25Scores = new Map<string, number>();
  for (const r of bm25Hits) {
    if (r.score) {
      bm25Scores.set(chunkKey(r.chunk), r.score);
    }
  }

  const normalizedSemantic = rrfScores(semanticScores);
  const normalizedBm25 = rrfScores(bm25Scores);

  const allKeys = new Set([...normalizedSemantic.keys(), ...normalizedBm25.keys()]);
  const sortedKeys = [...allKeys].sort((a, b) => {
    const ca = chunksByKey.get(a);
    const cb = chunksByKey.get(b);
    if (!ca || !cb) {
      return 0;
    }
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
    boostMultiChunkFiles(combinedScores, chunksByKey);
    applyQueryBoost(combinedScores, query, chunks, chunksByKey);
    const ranked = rerankTopk(combinedScores, chunksByKey, topK, alphaWeight < 1.0);
    return ranked.map(([chunk, score]) => ({ chunk, score }));
  }

  return [...combinedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .flatMap(([key, score]) => {
      const chunk = chunksByKey.get(key);
      if (!chunk) {
        return [];
      }
      return [{ chunk, score }];
    });
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
