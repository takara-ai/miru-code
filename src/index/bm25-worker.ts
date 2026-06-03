import type { Bm25ScoreJob, Bm25ScoreResult } from "./bm25-types.ts";

const K1 = 1.5;
const B = 0.75;

function scoreSlice(job: Bm25ScoreJob): number[] {
  const { startDoc, endDoc, docLengths, avgDocLength, terms, postings, weightMask } = job;
  const len = endDoc - startDoc;
  const scores = new Array<number>(len).fill(0);
  const avg = avgDocLength || 1;

  for (const { term, idf } of terms) {
    const list = postings[term];
    if (!list) {
      continue;
    }
    for (const [docIndex, tf] of list) {
      if (docIndex < startDoc || docIndex >= endDoc) {
        continue;
      }
      if (weightMask && !weightMask[docIndex]) {
        continue;
      }
      const dl = docLengths[docIndex];
      if (dl === undefined) {
        continue;
      }
      const denom = tf + K1 * (1 - B + (B * dl) / avg);
      const offset = docIndex - startDoc;
      scores[offset] = (scores[offset] ?? 0) + idf * ((tf * (K1 + 1)) / denom);
    }
  }

  return scores;
}

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Bm25ScoreJob>) => void;
  postMessage: (message: Bm25ScoreResult) => void;
};

workerScope.onmessage = (event: MessageEvent<Bm25ScoreJob>) => {
  const job = event.data;
  workerScope.postMessage({
    startDoc: job.startDoc,
    scores: scoreSlice(job),
  });
};
