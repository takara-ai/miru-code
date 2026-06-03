/** Shared query interface for float and quantized vector indexes. */
export interface SemanticIndex {
  readonly size: number;
  readonly dimensions: number;
  memoryBytes(): number;
  query(
    queryVector: Float32Array,
    k: number,
    selector?: number[],
  ): { indices: number[]; distances: number[] };
}
