/** Deterministic PRNG for tests (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizedRandom(dim: number, rand: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = rand() * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += (v[i] ?? 0) * (v[i] ?? 0);
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) {
    v[i] = (v[i] ?? 0) / norm;
  }
  return v;
}

export function unitVector(dim: number, activeIndex: number, value = 1): Float32Array {
  const v = new Float32Array(dim);
  v[activeIndex] = value;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += (v[i] ?? 0) * (v[i] ?? 0);
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) {
    v[i] = (v[i] ?? 0) / norm;
  }
  return v;
}
