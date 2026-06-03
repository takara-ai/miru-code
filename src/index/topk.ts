export interface TopKDistanceEntry {
  index: number;
  distance: number;
}

/** Keep the k smallest distances (best cosine matches). */
export function selectTopKByDistance(
  entries: Iterable<TopKDistanceEntry>,
  k: number,
): TopKDistanceEntry[] {
  const top: TopKDistanceEntry[] = [];
  for (const entry of entries) {
    if (top.length < k) {
      top.push(entry);
      top.sort((a, b) => b.distance - a.distance);
      continue;
    }
    const worst = top[0];
    if (worst && entry.distance < worst.distance) {
      top[0] = entry;
      top.sort((a, b) => b.distance - a.distance);
    }
  }
  top.sort((a, b) => a.distance - b.distance);
  return top;
}

/** Indices of the k highest scores in a dense array. */
export function selectTopKScoreIndices(scores: number[], k: number): number[] {
  if (k <= 0 || scores.length === 0) {
    return [];
  }
  const top: { v: number; i: number }[] = [];
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (v === undefined) {
      continue;
    }
    if (top.length < k) {
      top.push({ v, i });
      top.sort((a, b) => a.v - b.v);
      continue;
    }
    const worst = top[0];
    if (worst && v > worst.v) {
      top[0] = { v, i };
      top.sort((a, b) => a.v - b.v);
    }
  }
  top.sort((a, b) => b.v - a.v);
  return top.map((x) => x.i);
}
