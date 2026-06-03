import { VectorIndex } from "./dense.ts";
import { QuantizedVectorIndex } from "./quantize.ts";
import type { SemanticIndex } from "./semantic-index.ts";

/** Recover a float embedding for incremental re-indexing (unchanged chunks). */
export function vectorAt(index: SemanticIndex, docIndex: number): Float32Array {
  if (index instanceof VectorIndex) {
    const vec = index.getVectors()[docIndex];
    if (!vec) {
      throw new Error(`Missing vector at index ${docIndex}`);
    }
    return vec;
  }
  if (index instanceof QuantizedVectorIndex) {
    return index.vectorAt(docIndex);
  }
  throw new Error("Unsupported semantic index type");
}
