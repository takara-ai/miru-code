import { resolve } from "node:path";
import type { Chunk, ContentType, SearchResult } from "./types.ts";
import { searchResultToDict } from "./types.ts";

const GIT_URL_SCHEMES = [
  "https://",
  "http://",
  "ssh://",
  "git://",
  "git+ssh://",
  "file://",
] as const;
const SCP_GIT_URL_RE = /^[\w.-]+@[\w.-]+:(?!\/)/;

export function isGitUrl(path: string): boolean {
  return GIT_URL_SCHEMES.some((scheme) => path.startsWith(scheme)) || SCP_GIT_URL_RE.test(path);
}

export function isAllowedRepoSource(repo: string): boolean {
  if (!isGitUrl(repo)) {
    return true;
  }
  return repo.startsWith("https://") || repo.startsWith("http://");
}

export function resolveChunk(chunks: Chunk[], filePath: string, line: number): Chunk | null {
  let fallback: Chunk | null = null;
  for (const chunk of chunks) {
    if (chunk.file_path === filePath && chunk.start_line <= line && line <= chunk.end_line) {
      if (line < chunk.end_line) {
        return chunk;
      }
      if (fallback === null) {
        fallback = chunk;
      }
    }
  }
  return fallback;
}

export function formatResults(
  query: string,
  results: SearchResult[],
): { query: string; results: Record<string, unknown>[] } {
  return {
    query,
    results: results.map(searchResultToDict),
  };
}

export function resolveContent(raw: string[]): ContentType[] {
  if (raw.includes("all")) {
    return ["code", "docs", "config"];
  }
  const valid: ContentType[] = ["code", "docs", "config"];
  return raw.filter((item): item is ContentType => valid.includes(item as ContentType));
}

export function computeSourceCacheKey(source: string, ref?: string | null): string {
  if (isGitUrl(source)) {
    return ref ? `${source}@${ref}` : source;
  }
  return resolve(source);
}

/** Resolve a local search path; leave git URLs unchanged for remote indexing. */
export function resolveSearchPath(path: string): string {
  return isGitUrl(path) ? path : resolve(path);
}
