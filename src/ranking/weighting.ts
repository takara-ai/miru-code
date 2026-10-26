import { isSymbolQuery } from "./boosting.ts";
import { rankingConfig } from "./config.ts";

const ALPHA_SYMBOL = 0.3;
// Alpha is the semantic contribution. Rank and score fusion need separate weights.
const ALPHA_NL_RRF = 0.25;
// Selected by MRR@3 on 600 queries; 2400 reserved for evaluation of the frozen winner.
const ALPHA_NL_LINEAR = 0.4;

export function resolveAlpha(query: string, alpha: number | null | undefined): number {
  if (alpha != null) {
    return alpha;
  }
  const configured = process.env.MIRU_RANK_ALPHA?.trim();
  if (configured) {
    const value = Number(configured);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  if (isSymbolQuery(query)) return ALPHA_SYMBOL;
  return rankingConfig().fusion === "rrf" ? ALPHA_NL_RRF : ALPHA_NL_LINEAR;
}
