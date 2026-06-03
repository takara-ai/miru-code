export type PostingsList = [docIndex: number, tf: number][];

export type SerializablePostings = Record<string, PostingsList>;

export interface Bm25ScoreJob {
  startDoc: number;
  endDoc: number;
  docLengths: number[];
  avgDocLength: number;
  terms: { term: string; idf: number }[];
  postings: SerializablePostings;
  weightMask?: boolean[];
}

export interface Bm25ScoreResult {
  startDoc: number;
  scores: number[];
}
