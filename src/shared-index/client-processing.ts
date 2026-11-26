import { chunkSource } from "../chunking/chunking.ts";
import { detectLanguage } from "../index/files.ts";
import { buildBm25FromChunks } from "../index/sparse.ts";
import { rankHybridCandidates } from "../search.ts";
import { tokenize } from "../tokens.ts";
import { type Chunk, chunkKey } from "../types.ts";
import {
  type FileChange,
  type PreparedChange,
  type SharedCandidates,
  type SharedResult,
  sharedContentHash,
} from "./protocol.ts";

export async function prepareSharedFile({
  content,
  ...change
}: FileChange): Promise<PreparedChange> {
  if (content === null) return { ...change, fileHash: null, chunks: [] };
  const chunks = await chunkSource(content, change.path, detectLanguage(change.path));
  return {
    ...change,
    fileHash: sharedContentHash(content),
    chunks: chunks.map(({ file_path: _path, ...chunk }) => ({
      ...chunk,
      hash: sharedContentHash(chunk.content),
    })),
  };
}

export function rankSharedSearch(
  { model, candidates }: SharedCandidates,
  query: string,
  limit: number,
): SharedResult[] {
  const originals = new Map<string, SharedCandidates["candidates"][number]>();
  const chunksByKey = new Map<string, Chunk>();
  const semanticScores = new Map<string, number>();
  for (const row of candidates) {
    const chunk = {
      file_path: `${encodeURIComponent(row.repository)}/${row.file_path}`,
      start_line: row.start_line,
      end_line: row.end_line,
      language: row.language,
      content: row.content,
    };
    const key = chunkKey(chunk);
    if (chunksByKey.has(key)) continue;
    originals.set(key, row);
    chunksByKey.set(key, chunk);
    semanticScores.set(key, Math.max(0, row.similarity));
  }
  const chunks = [...chunksByKey.values()];
  const weights = buildBm25FromChunks(chunks).getScores(tokenize(query));
  const bm25Scores = new Map(chunks.map((chunk, i) => [chunkKey(chunk), weights[i] ?? 0]));
  return rankHybridCandidates(
    { chunksByKey, semanticScores, bm25Scores, embeddingModel: model },
    { query, chunks, topK: limit },
  ).map(({ chunk, score }) => {
    const original = originals.get(chunkKey(chunk));
    if (!original) throw new Error("Ranker returned an unknown shared index chunk.");
    return {
      repository: original.repository,
      score,
      chunk: { ...chunk, file_path: original.file_path },
    };
  });
}
