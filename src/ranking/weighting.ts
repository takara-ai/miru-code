import { isSymbolQuery } from "./boosting.ts";

const ALPHA_SYMBOL = 0.3;
const ALPHA_NL = 0.5;

export function resolveAlpha(query: string, alpha: number | null | undefined): number {
  if (alpha != null) {
    return alpha;
  }
  return isSymbolQuery(query) ? ALPHA_SYMBOL : ALPHA_NL;
}
