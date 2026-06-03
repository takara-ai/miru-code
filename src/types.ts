export type ContentType = "code" | "docs" | "config";

export interface Chunk {
  content: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string | null;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export function chunkKey(chunk: Chunk): string {
  return `${chunk.file_path}:${chunk.start_line}:${chunk.end_line}`;
}

export function chunkToDict(chunk: Chunk): Record<string, unknown> {
  return {
    content: chunk.content,
    file_path: chunk.file_path,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    language: chunk.language,
    location: `${chunk.file_path}:${chunk.start_line}-${chunk.end_line}`,
  };
}

export function chunkFromDict(data: Record<string, unknown>): Chunk {
  const { location: _loc, ...rest } = data;
  return {
    content: String(rest.content),
    file_path: String(rest.file_path),
    start_line: Number(rest.start_line),
    end_line: Number(rest.end_line),
    language: rest.language == null ? null : String(rest.language),
  };
}

export function searchResultToDict(result: SearchResult): Record<string, unknown> {
  return {
    chunk: chunkToDict(result.chunk),
    score: result.score,
  };
}
