type QuantizedVector = {
  codes: Int8Array;
  scale: number;
};

/** Reference scalar int8 dot product (A/B regression baseline). */
export function quantizedDotFlatScalar(
  query: QuantizedVector,
  codes: Int8Array,
  offset: number,
  dim: number,
  docScale: number,
): number {
  let sum = 0;
  const q = query.codes;
  for (let i = 0; i < dim; i++) {
    sum += q[i] * codes[offset + i];
  }
  return sum * query.scale * docScale;
}

/** Production int8 dot product with 8-wide unrolling for JSC auto-vectorization. */
export function quantizedDotFlat(
  query: QuantizedVector,
  codes: Int8Array,
  offset: number,
  dim: number,
  docScale: number,
): number {
  const q = query.codes;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let s5 = 0;
  let s6 = 0;
  let s7 = 0;
  let i = 0;
  for (; i + 7 < dim; i += 8) {
    s0 += q[i] * codes[offset + i];
    s1 += q[i + 1] * codes[offset + i + 1];
    s2 += q[i + 2] * codes[offset + i + 2];
    s3 += q[i + 3] * codes[offset + i + 3];
    s4 += q[i + 4] * codes[offset + i + 4];
    s5 += q[i + 5] * codes[offset + i + 5];
    s6 += q[i + 6] * codes[offset + i + 6];
    s7 += q[i + 7] * codes[offset + i + 7];
  }
  let sum = s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7;
  for (; i < dim; i++) {
    sum += q[i] * codes[offset + i];
  }
  return sum * query.scale * docScale;
}
