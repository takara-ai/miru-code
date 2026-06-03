import type { Chunk } from "../types.ts";
import { chunkLines } from "./lines.ts";
import { chunkStructural } from "./structural.ts";

/** Match upstream hybrid-search chunking target length. */
const DESIRED_CHUNK_LENGTH_CHARS = 1500;

export function chunkSource(source: string, filePath: string, language: string | null): Chunk[] {
  if (!source.trim()) {
    return [];
  }

  const boundaries =
    chunkStructural(source, language, DESIRED_CHUNK_LENGTH_CHARS) ??
    chunkLines(source, DESIRED_CHUNK_LENGTH_CHARS);
  const chunks: Chunk[] = [];
  const prefixNewlineCounts = new Uint32Array(source.length + 1);
  for (let i = 0; i < source.length; i++) {
    const prevCount = prefixNewlineCounts[i] ?? 0;
    prefixNewlineCounts[i + 1] = prevCount + (source[i] === "\n" ? 1 : 0);
  }

  for (const boundary of boundaries) {
    const endIndex = Math.max(boundary.end - 1, boundary.start);
    const text = source.slice(boundary.start, endIndex + 1);
    chunks.push({
      content: text,
      file_path: filePath,
      start_line: (prefixNewlineCounts[boundary.start] ?? 0) + 1,
      end_line: (prefixNewlineCounts[endIndex] ?? 0) + 1,
      language,
    });
  }

  return chunks;
}
