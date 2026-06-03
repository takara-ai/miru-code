import { VectorIndex } from "./dense.ts";
import { QuantizedVectorIndex } from "./quantize.ts";
import type { SemanticIndex } from "./semantic-index.ts";

export type SemanticStorage = "int8" | "float32";

/** Default: int8 quantized vectors (~4x less RAM). Set MIRU_FLOAT_VECTORS=1 for float32. */
export function resolveSemanticStorage(): SemanticStorage {
  return process.env.MIRU_FLOAT_VECTORS === "1" || process.env.SEMBLE_FLOAT_VECTORS === "1"
    ? "float32"
    : "int8";
}

export function semanticStorageFromMetadata(metadata: Record<string, unknown>): SemanticStorage {
  return metadata.vector_storage === "float32" ? "float32" : "int8";
}

export function buildSemanticIndex(vectors: Float32Array[]): SemanticIndex {
  if (resolveSemanticStorage() === "int8") {
    return new QuantizedVectorIndex(vectors);
  }
  return new VectorIndex(vectors);
}

export function semanticStorageOf(index: SemanticIndex): SemanticStorage {
  return index instanceof QuantizedVectorIndex ? "int8" : "float32";
}
