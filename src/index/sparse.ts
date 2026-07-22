import { tokenize } from "../tokens.ts";
import type { Chunk } from "../types.ts";
import { BM25Index } from "./bm25.ts";

export function selectorToMask(
  selector: readonly number[] | null | undefined,
  size: number,
): boolean[] | undefined {
  if (!selector || selector.length === 0) {
    return undefined;
  }
  const mask = new Array<boolean>(size).fill(false);
  for (const idx of selector) {
    if (idx >= 0 && idx < size) {
      mask[idx] = true;
    }
  }
  return mask;
}

export function enrichForBm25(chunk: Chunk): string {
  const parts = chunk.file_path.replace(/\\/g, "/").split("/");
  const stem = parts[parts.length - 1]?.replace(/\.[^.]+$/, "") ?? "";
  const dirParts = parts.slice(0, -1).filter((p) => p && p !== "." && p !== "..");
  const dirText = dirParts.slice(-3).join(" ");
  return `${chunk.content} ${stem} ${stem} ${dirText}`;
}

export function addChunkToBm25(bm25: BM25Index, chunk: Chunk): void {
  bm25.addDocument(tokenize(enrichForBm25(chunk)));
}

export function buildBm25FromChunks(chunks: readonly Chunk[]): BM25Index {
  const bm25 = new BM25Index();
  for (const chunk of chunks) {
    addChunkToBm25(bm25, chunk);
  }
  return bm25;
}
