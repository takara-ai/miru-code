/** Optional ranking overrides, primarily for reproducible offline calibration. */
export interface RankingConfig {
  rrfK: number;
  candidateMultiplier: number;
  locationCandidateMultiplier: number;
  fileCoherenceBoost: number;
  definitionBoost: number;
  embeddedSymbolScale: number;
  exactStemBoost: number;
  locationBoost: number;
  pathPenalties: boolean;
  fileSaturationDecay: number;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function rankingConfig(): RankingConfig {
  return {
    // Validated on the cached 3k CodeSearchNet corpus. Overrides preserve a
    // straightforward rollback/A-B path for repository-specific evaluation.
    rrfK: numberEnv("MIRU_RANK_RRF_K", 10, 1, 500),
    candidateMultiplier: numberEnv("MIRU_RANK_CANDIDATE_MULTIPLIER", 5, 1, 50),
    locationCandidateMultiplier: numberEnv("MIRU_RANK_LOCATION_CANDIDATE_MULTIPLIER", 10, 1, 100),
    fileCoherenceBoost: numberEnv("MIRU_RANK_FILE_COHERENCE_BOOST", 0, 0, 2),
    definitionBoost: numberEnv("MIRU_RANK_DEFINITION_BOOST", 3, 0, 10),
    embeddedSymbolScale: numberEnv("MIRU_RANK_EMBEDDED_SYMBOL_SCALE", 0.5, 0, 2),
    exactStemBoost: numberEnv("MIRU_RANK_EXACT_STEM_BOOST", 0.75, 0, 3),
    locationBoost: numberEnv("MIRU_RANK_LOCATION_BOOST", 2.5, 0, 10),
    pathPenalties: process.env.MIRU_RANK_PATH_PENALTIES !== "0",
    fileSaturationDecay: numberEnv("MIRU_RANK_FILE_SATURATION_DECAY", 0.5, 0.05, 1),
  };
}
