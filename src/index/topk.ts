export interface TopKDistanceEntry {
  index: number;
  distance: number;
}

/** Keep the k smallest distances (best cosine matches). Legacy reference implementation. */
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

/**
 * Incremental top-k by smallest distance using a size-k max-heap.
 * Avoids materializing all candidate scores before selection.
 */
export class TopKDistanceCollector {
  private readonly heap: TopKDistanceEntry[] = [];

  constructor(private readonly k: number) {}

  offer(index: number, distance: number): void {
    if (this.k <= 0) {
      return;
    }
    if (this.heap.length < this.k) {
      this.heap.push({ index, distance });
      this.bubbleUp(this.heap.length - 1);
      return;
    }
    const worst = this.heap[0];
    if (worst && distance < worst.distance) {
      this.heap[0] = { index, distance };
      this.siftDown(0);
    }
  }

  finish(): TopKDistanceEntry[] {
    return [...this.heap].sort((a, b) => a.distance - b.distance);
  }

  private parent(i: number): number {
    return (i - 1) >> 1;
  }

  private left(i: number): number {
    return (i << 1) + 1;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = this.parent(i);
      const here = this.heap[i];
      const parent = this.heap[p];
      if (!here || !parent || here.distance <= parent.distance) {
        break;
      }
      this.heap[i] = parent;
      this.heap[p] = here;
      i = p;
    }
  }

  private siftDown(i: number): void {
    while (true) {
      const left = this.left(i);
      if (left >= this.heap.length) {
        break;
      }
      const right = left + 1;
      let largest = left;
      if (
        right < this.heap.length &&
        (this.heap[right]?.distance ?? -Infinity) > (this.heap[left]?.distance ?? -Infinity)
      ) {
        largest = right;
      }
      const here = this.heap[i];
      const child = this.heap[largest];
      if (!here || !child || child.distance <= here.distance) {
        break;
      }
      this.heap[i] = child;
      this.heap[largest] = here;
      i = largest;
    }
  }
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
