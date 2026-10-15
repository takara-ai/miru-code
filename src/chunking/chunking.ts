import type { Chunk } from "../types.ts";
import { chunkAst } from "./ast.ts";
import { type ChunkBoundary, chunkLines } from "./lines.ts";
import { chunkStructural } from "./structural.ts";

/** Match upstream hybrid-search chunking target length. */
const DESIRED_CHUNK_LENGTH_CHARS = 1500;

/**
 * Sibling AST nodes split mid-line leave their inter-token whitespace in no chunk, so rejoining
 * the line later yields `exportasync`. Extend the earlier chunk across a same-line, whitespace-only
 * gap; gaps containing a newline (between declarations) are left exactly as they were.
 */
function closeSameLineGap(
  source: string,
  boundary: ChunkBoundary,
  next: ChunkBoundary | undefined,
): ChunkBoundary {
  if (!next || next.start <= boundary.end) {
    return boundary;
  }
  return /^[^\S\n]+$/.test(source.slice(boundary.end, next.start))
    ? { start: boundary.start, end: next.start }
    : boundary;
}

export async function chunkSource(
  source: string,
  filePath: string,
  language: string | null,
): Promise<Chunk[]> {
  if (!source.trim()) {
    return [];
  }

  const boundaries =
    (await chunkAst(source, filePath, language, DESIRED_CHUNK_LENGTH_CHARS)) ??
    chunkStructural(source, language, DESIRED_CHUNK_LENGTH_CHARS) ??
    chunkLines(source, DESIRED_CHUNK_LENGTH_CHARS);
  const chunks: Chunk[] = [];
  const prefixNewlineCounts = new Uint32Array(source.length + 1);
  for (let i = 0; i < source.length; i++) {
    const prevCount = prefixNewlineCounts[i] ?? 0;
    prefixNewlineCounts[i + 1] = prevCount + (source[i] === "\n" ? 1 : 0);
  }

  for (const [i, raw] of boundaries.entries()) {
    const boundary = closeSameLineGap(source, raw, boundaries[i + 1]);
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
