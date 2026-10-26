import { readFileSync, statSync } from "node:fs";
import { type Chunk, chunkKey, type SearchResult } from "../types.ts";
import {
  ALWAYS_ON_FEATURE_NAMES,
  ALWAYS_ON_FEATURE_VERSION,
  buildAlwaysOnRankFeatures,
} from "./always-on-features.ts";
import { rankingConfig } from "./config.ts";
import { searchImprovementsEnabled } from "./features.ts";
import { buildRankFeatures, RANK_FEATURE_NAMES, RANK_FEATURE_VERSION } from "./learned-features.ts";
import bundledResidualModel from "./residual-model.json";

interface RankTree {
  feature: number[];
  threshold: number[];
  left: number[];
  right: number[];
  value: number[];
}
export interface ResidualRankerModel {
  version: "residual-v1" | "residual-v2";
  featureVersion: number;
  features: string[];
  embeddingModel: "ds1-miru-int8";
  candidateTopK: 10;
  prior: { alpha: 0.4; normalization: "max"; scale: 3 };
  featureBase: { alpha: 0.7; normalization: "minmax" };
  eta: 1;
  clip: 3;
  postprocessing: "bounded-residual-best-chunk-per-file";
  sourceModelSha256: string;
  trees: RankTree[];
}

export function validateResidualModel(input: unknown): ResidualRankerModel {
  const model = input as ResidualRankerModel;
  if (
    !(
      (model?.version === "residual-v1" &&
        model.featureVersion === RANK_FEATURE_VERSION &&
        JSON.stringify(model.features) === JSON.stringify(RANK_FEATURE_NAMES)) ||
      (model?.version === "residual-v2" &&
        model.featureVersion === ALWAYS_ON_FEATURE_VERSION &&
        JSON.stringify(model.features) === JSON.stringify(ALWAYS_ON_FEATURE_NAMES))
    ) ||
    model.embeddingModel !== "ds1-miru-int8" ||
    model.candidateTopK !== 10 ||
    model.prior?.alpha !== 0.4 ||
    model.prior.normalization !== "max" ||
    model.prior.scale !== 3 ||
    model.featureBase?.alpha !== 0.7 ||
    model.featureBase.normalization !== "minmax" ||
    model.eta !== 1 ||
    model.clip !== 3 ||
    model.postprocessing !== "bounded-residual-best-chunk-per-file" ||
    !/^[a-f0-9]{64}$/.test(model.sourceModelSha256) ||
    !Array.isArray(model.trees) ||
    !model.trees.length ||
    model.trees.length > 1000
  )
    throw Error("Invalid or incompatible residual ranker model");
  for (const tree of model.trees) {
    const n = tree.feature?.length;
    if (
      !n ||
      n > 4096 ||
      [tree.threshold, tree.left, tree.right, tree.value].some(
        (a) => !Array.isArray(a) || a.length !== n,
      )
    )
      throw Error("Invalid residual tree shape");
    for (let i = 0; i < n; i++) {
      const feature = tree.feature[i];
      if (
        !Number.isInteger(feature) ||
        feature == null ||
        feature < -1 ||
        feature >= model.features.length ||
        !Number.isFinite(tree.threshold[i]) ||
        !Number.isFinite(tree.value[i])
      )
        throw Error("Invalid residual tree node");
      if (
        feature !== -1 &&
        [tree.left[i], tree.right[i]].some(
          (child) => !Number.isInteger(child) || child == null || child <= i || child >= n,
        )
      )
        throw Error("Residual tree child must point forward");
    }
  }
  return model;
}

export function predictResidual(model: ResidualRankerModel, features: readonly number[]): number {
  if (features.length !== model.features.length || features.some((v) => !Number.isFinite(v)))
    throw Error("Invalid residual feature vector");
  let score = 0;
  for (const tree of model.trees) {
    let i = 0;
    while ((tree.feature[i] ?? -1) >= 0)
      i =
        (features[tree.feature[i] as number] as number) <= (tree.threshold[i] as number)
          ? (tree.left[i] as number)
          : (tree.right[i] as number);
    score += tree.value[i] as number;
  }
  if (!Number.isFinite(score)) throw Error("Non-finite residual prediction");
  return score;
}

let cached: { path: string; size: number; mtime: number; model: ResidualRankerModel } | null = null;
let bundled: ResidualRankerModel | null = null;
export function configuredResidualRanker(): ResidualRankerModel | null {
  const path = process.env.MIRU_RESIDUAL_RANK_MODEL?.trim();
  if (path === "0") return null;
  if (!path) {
    if (!bundled) bundled = validateResidualModel(bundledResidualModel);
    return bundled;
  }
  const stat = statSync(path);
  if (cached?.path === path && cached.size === stat.size && cached.mtime === stat.mtimeMs)
    return cached.model;
  if (stat.size > 10_000_000) throw Error("Residual model exceeds 10 MB limit");
  const model = validateResidualModel(JSON.parse(readFileSync(path, "utf8")));
  cached = { path, size: stat.size, mtime: stat.mtimeMs, model };
  return model;
}

/** Every compatible code query uses the configured scorer; query text never routes it. */
export function activeResidualRanker(
  _query: string,
  embeddingModel?: string,
  alpha?: number | null,
  rerank = true,
): ResidualRankerModel | null {
  if (!rerank || embeddingModel !== "ds1-miru-int8" || !searchImprovementsEnabled()) return null;
  const tuning = rankingConfig();
  const configuredAlpha = Number(process.env.MIRU_RANK_ALPHA?.trim() || NaN);
  const explicitAlpha =
    alpha ??
    (Number.isFinite(configuredAlpha) && configuredAlpha >= 0 && configuredAlpha <= 1
      ? configuredAlpha
      : undefined);
  const expected = {
    fusion: "linear",
    linearNormalization: "max",
    linearQueryBoostScale: 0.5,
    candidateMultiplier: 5,
    locationCandidateMultiplier: 10,
    fileCoherenceBoost: 0,
    definitionBoost: 3,
    embeddedSymbolScale: 0.5,
    exactStemBoost: 0.75,
    locationBoost: 2.5,
    pathPenalties: true,
    fileSaturationDecay: 0.5,
  };
  if (
    (explicitAlpha != null && explicitAlpha !== 0.4) ||
    Object.entries(expected).some(([key, value]) => tuning[key as keyof typeof tuning] !== value)
  )
    return null;
  return configuredResidualRanker();
}

/** Compatible code searches return four by default; zero restores the five-result budget. */
export function residualSearchResultCount(
  query: string,
  embeddingModel: string,
  rerank = true,
): number {
  return process.env.MIRU_RESIDUAL_TOP4?.trim() !== "0" &&
    activeResidualRanker(query, embeddingModel, undefined, rerank)
    ? 4
    : 5;
}

export function rankResidualCandidates(
  model: ResidualRankerModel,
  query: string,
  semantic: Map<string, number>,
  bm25: Map<string, number>,
  priorRanked: SearchResult[],
  featureRanked: SearchResult[],
  topK: number,
): SearchResult[] {
  const restored = new Map<string, number>(),
    counts = new Map<string, number>();
  for (const { chunk, score } of priorRanked) {
    const n = counts.get(chunk.file_path) ?? 0;
    counts.set(chunk.file_path, n + 1);
    restored.set(chunkKey(chunk), score / rankingConfig().fileSaturationDecay ** n);
  }
  const maximum = Math.max(0, ...restored.values());
  const built =
    model.version === "residual-v2"
      ? buildAlwaysOnRankFeatures(query, semantic, bm25, priorRanked, featureRanked)
      : buildRankFeatures(query, semantic, bm25, featureRanked);
  const scored = built.chunks.map((chunk: Chunk, i) => {
    const prior = restored.get(chunkKey(chunk)) ?? 0;
    const normalized = Math.fround(maximum ? (model.prior.scale * prior) / maximum : 0);
    const residual = Math.max(
      -model.clip,
      Math.min(model.clip, predictResidual(model, built.features[i] as number[])),
    );
    return { chunk, score: normalized + model.eta * residual };
  });
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return scored
    .filter((r) => {
      if (seen.has(r.chunk.file_path)) return false;
      seen.add(r.chunk.file_path);
      return true;
    })
    .slice(0, topK);
}
