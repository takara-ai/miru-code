import { isSymbolQuery } from "./boosting.ts";

const ALPHA_SYMBOL = 0.3;
// Natural-language code queries benefit from a modest lexical preference:
// CodeSearchNet factorial sweep (3k full validation) improved exact-match@1,
// hit@3, and MRR at 0.25 versus the former 0.50.
const ALPHA_NL = 0.25;

export function resolveAlpha(query: string, alpha: number | null | undefined): number {
  if (alpha != null) {
    return alpha;
  }
  return isSymbolQuery(query) ? ALPHA_SYMBOL : ALPHA_NL;
}
