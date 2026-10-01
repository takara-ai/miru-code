/** Okapi BM25 with inverted postings; optional worker-parallel scoring. */

import { resolveWorkerConcurrency } from "../concurrency.ts";
import type {
  Bm25ScoreJob,
  Bm25ScoreResult,
  PostingsList,
  SerializablePostings,
} from "./bm25-types.ts";

const K1 = 1.5;
const B = 0.75;

/** Use workers when doc count exceeds this (overhead not worth it below). */
const PARALLEL_SCORE_MIN_DOCS = 256;

function docRanges(numDocs: number, parts: number): [number, number][] {
  const n = Math.max(1, Math.min(parts, numDocs));
  const ranges: [number, number][] = [];
  const chunk = Math.ceil(numDocs / n);
  for (let start = 0; start < numDocs; start += chunk) {
    ranges.push([start, Math.min(numDocs, start + chunk)]);
  }
  return ranges;
}

function runScoreWorker(job: Bm25ScoreJob): Promise<Bm25ScoreResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./bm25-worker.ts", import.meta.url).href, {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<Bm25ScoreResult>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage(job);
  });
}

export class BM25Index {
  private docFreq: Map<string, number>;
  private docLengths: number[];
  private postings: Map<string, PostingsList>;
  private avgDocLength: number;
  private numDocs: number;
  private totalLen: number;

  constructor() {
    this.docFreq = new Map();
    this.docLengths = [];
    this.postings = new Map();
    this.avgDocLength = 0;
    this.numDocs = 0;
    this.totalLen = 0;
  }

  /** Append one tokenized document. Safe to call incrementally while indexing. */
  addDocument(doc: string[]): number {
    const docIndex = this.numDocs;
    this.numDocs += 1;
    this.docLengths.push(doc.length);
    this.totalLen += doc.length;
    this.avgDocLength = this.totalLen / this.numDocs;

    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    for (const [term, count] of tf) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push([docIndex, count]);
    }
    return docIndex;
  }

  get size(): number {
    return this.numDocs;
  }

  /**
   * A new index with the given documents removed and later doc indices shifted down,
   * equal to re-indexing the surviving docs in order. `this` is left untouched, so
   * searches already holding it never see a half-updated index.
   */
  withoutDocuments(removed: ReadonlySet<number>): BM25Index {
    const next = new BM25Index();
    const remap = new Int32Array(this.numDocs);
    let kept = 0;
    let firstRemoved = this.numDocs;
    for (let doc = 0; doc < this.numDocs; doc++) {
      if (removed.has(doc)) {
        remap[doc] = -1;
        if (firstRemoved === this.numDocs) {
          firstRemoved = doc;
        }
      } else {
        remap[doc] = kept++;
        const length = this.docLengths[doc] ?? 0;
        next.docLengths.push(length);
        next.totalLen += length;
      }
    }
    next.numDocs = kept;
    next.avgDocLength = kept === 0 ? 0 : next.totalLen / kept;

    for (const [term, list] of this.postings) {
      // Lists ascend by doc index, so one ending before the first removal is untouched.
      // Copy the array (addDocument appends to it) but share the immutable tuples.
      const untouched = (list.at(-1)?.[0] ?? 0) < firstRemoved;
      const nextList: PostingsList = untouched ? list.slice() : [];
      if (!untouched) {
        for (const entry of list) {
          const mapped = remap[entry[0]] ?? -1;
          if (mapped !== -1) {
            nextList.push(mapped === entry[0] ? entry : [mapped, entry[1]]);
          }
        }
      }
      if (nextList.length > 0) {
        next.postings.set(term, nextList);
        next.docFreq.set(term, nextList.length);
      }
    }
    return next;
  }

  index(tokenizedDocs: string[][]): void {
    this.numDocs = 0;
    this.docFreq.clear();
    this.docLengths = [];
    this.postings.clear();
    this.totalLen = 0;
    this.avgDocLength = 0;

    for (const doc of tokenizedDocs) {
      if (!doc) {
        continue;
      }
      this.addDocument(doc);
    }
  }

  private queryTerms(queryTokens: string[]): { term: string; idf: number }[] {
    const unique = [...new Set(queryTokens)];
    const terms: { term: string; idf: number }[] = [];
    for (const term of unique) {
      const df = this.docFreq.get(term) ?? 0;
      if (df === 0) {
        continue;
      }
      terms.push({
        term,
        idf: Math.log(1 + (this.numDocs - df + 0.5) / (df + 0.5)),
      });
    }
    return terms;
  }

  private postingsForTerms(terms: { term: string; idf: number }[]): SerializablePostings {
    const out: SerializablePostings = {};
    for (const { term } of terms) {
      const list = this.postings.get(term);
      if (list) {
        out[term] = list;
      }
    }
    return out;
  }

  getScores(queryTokens: string[], weightMask?: boolean[]): number[] {
    const scores = new Array<number>(this.numDocs).fill(0);
    if (this.numDocs === 0 || queryTokens.length === 0) {
      return scores;
    }

    const terms = this.queryTerms(queryTokens);
    const avg = this.avgDocLength || 1;

    for (const { term, idf } of terms) {
      const list = this.postings.get(term);
      if (!list) {
        continue;
      }
      for (const [docIndex, tf] of list) {
        if (weightMask && !weightMask[docIndex]) {
          continue;
        }
        const dl = this.docLengths[docIndex];
        if (dl === undefined) {
          continue;
        }
        const denom = tf + K1 * (1 - B + (B * dl) / avg);
        scores[docIndex] = (scores[docIndex] ?? 0) + idf * ((tf * (K1 + 1)) / denom);
      }
    }

    return scores;
  }

  async getScoresAsync(queryTokens: string[], weightMask?: boolean[]): Promise<number[]> {
    const scores = new Array<number>(this.numDocs).fill(0);
    if (this.numDocs === 0 || queryTokens.length === 0) {
      return scores;
    }

    const terms = this.queryTerms(queryTokens);
    if (terms.length === 0) {
      return scores;
    }

    const concurrency = resolveWorkerConcurrency();
    if (this.numDocs < PARALLEL_SCORE_MIN_DOCS || concurrency <= 1) {
      return this.getScores(queryTokens, weightMask);
    }

    const postings = this.postingsForTerms(terms);
    const ranges = docRanges(this.numDocs, concurrency);
    const baseJob = {
      docLengths: this.docLengths,
      avgDocLength: this.avgDocLength,
      terms,
      postings,
      weightMask,
    };

    const partials = await Promise.all(
      ranges.map(([startDoc, endDoc]) => runScoreWorker({ ...baseJob, startDoc, endDoc })),
    );

    for (const { startDoc, scores: partial } of partials) {
      for (let i = 0; i < partial.length; i++) {
        const value = partial[i];
        if (value !== undefined) {
          scores[startDoc + i] = value;
        }
      }
    }

    return scores;
  }

  toJSON(): {
    postings: SerializablePostings;
    docLengths: number[];
    avgDocLength: number;
    numDocs: number;
  } {
    const postings: SerializablePostings = {};
    for (const [term, list] of this.postings.entries()) {
      postings[term] = list;
    }
    return {
      postings,
      docLengths: this.docLengths,
      avgDocLength: this.avgDocLength,
      numDocs: this.numDocs,
    };
  }

  static fromJSON(
    data:
      | {
          // Legacy cache format
          docs: string[][];
          docLengths: number[];
          docFreq: [string, number][];
        }
      | {
          // Current cache format
          postings: SerializablePostings;
          docLengths: number[];
          avgDocLength: number;
          numDocs: number;
        },
  ): BM25Index {
    const idx = new BM25Index();

    // New cache: restore postings directly (no need to re-index tokenized docs).
    if ("postings" in data) {
      idx.postings.clear();
      idx.docFreq.clear();
      idx.docLengths = data.docLengths;
      idx.avgDocLength = data.avgDocLength;
      idx.numDocs = data.numDocs;
      idx.totalLen = data.avgDocLength * data.numDocs;

      for (const [term, list] of Object.entries(data.postings)) {
        idx.postings.set(term, list);
        idx.docFreq.set(term, list.length);
      }

      return idx;
    }

    // Legacy cache: re-index from stored tokenized documents.
    idx.index(data.docs);
    return idx;
  }
}
