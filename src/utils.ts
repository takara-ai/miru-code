import { join, relative, resolve, sep } from "node:path";
import { applySnippetsToResults, searchSnippetsEnabled } from "./snippet.ts";
import type { Chunk, ContentType, SearchResult } from "./types.ts";
import { chunkToDict } from "./types.ts";

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

/** Resolved local repo root for MCP output; null for remote git URLs. */
export function localRepoRoot(repo: string): string | null {
  return isGitUrl(repo) ? null : resolve(repo);
}

/** Map an absolute or repo-relative path to the index-relative form. */
export function toIndexedFilePath(filePath: string, repoRoot?: string | null): string {
  if (!repoRoot) {
    return filePath;
  }
  const root = resolve(repoRoot);
  const candidate = resolve(root, filePath);
  if (candidate === root) {
    return "";
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate.startsWith(prefix)) {
    return relative(root, candidate).replace(/\\/g, "/");
  }
  return filePath;
}

export function resolveChunk(
  chunks: Chunk[],
  filePath: string,
  line: number,
  repoRoot?: string | null,
): Chunk | null {
  const indexedPath = toIndexedFilePath(filePath, repoRoot);
  let fallback: Chunk | null = null;
  for (const chunk of chunks) {
    if (chunk.file_path === indexedPath && chunk.start_line <= line && line <= chunk.end_line) {
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

export type ExpandResults = {
  file_path: string;
  line: number;
  chunk_count: number;
  anchor: Record<string, unknown> | null;
  chunks: Record<string, unknown>[];
};

export const DEFAULT_MCP_TOP_K = 3;
export const MAX_MCP_TOP_K = 10;

/** Clamp MCP top_k to a sane range; omit for the default. */
export function clampMcpTopK(topK?: number): number {
  const value = topK ?? DEFAULT_MCP_TOP_K;
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_MCP_TOP_K;
  }
  return Math.min(Math.floor(value), MAX_MCP_TOP_K);
}

function chunkToResponseDict(chunk: Chunk, repoRoot?: string | null): Record<string, unknown> {
  const dict = chunkToDict(chunk);
  if (!repoRoot) {
    return dict;
  }
  const absolutePath = join(resolve(repoRoot), chunk.file_path);
  return {
    ...dict,
    absolute_path: absolutePath,
    location: `${absolutePath}:${chunk.start_line}-${chunk.end_line}`,
  };
}

/** Keep the best-scoring chunk per file (preserves score order). */
export function dedupeResultsByFile(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const result of results) {
    const filePath = result.chunk.file_path;
    const existing = best.get(filePath);
    if (!existing || result.score > existing.score) {
      best.set(filePath, result);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function chunksForFile(
  chunks: Chunk[],
  filePath: string,
  repoRoot?: string | null,
): Chunk[] {
  const indexedPath = toIndexedFilePath(filePath, repoRoot);
  return chunks
    .filter((chunk) => chunk.file_path === indexedPath)
    .sort((a, b) => a.start_line - b.start_line);
}

/** Adjacent indexed chunks in the same file around `line`. */
export function expandChunksAtLine(
  chunks: Chunk[],
  filePath: string,
  line: number,
  repoRoot: string | null | undefined,
  before: number,
  after: number,
): { anchor: Chunk | null; chunks: Chunk[] } {
  const fileChunks = chunksForFile(chunks, filePath, repoRoot);
  if (fileChunks.length === 0) {
    return { anchor: null, chunks: [] };
  }

  const anchor = resolveChunk(chunks, filePath, line, repoRoot);
  if (!anchor) {
    return { anchor: null, chunks: [] };
  }

  const anchorIndex = fileChunks.findIndex(
    (chunk) => chunk.start_line === anchor.start_line && chunk.end_line === anchor.end_line,
  );
  if (anchorIndex < 0) {
    return { anchor, chunks: [anchor] };
  }

  const start = Math.max(0, anchorIndex - before);
  const end = Math.min(fileChunks.length, anchorIndex + after + 1);
  return { anchor, chunks: fileChunks.slice(start, end) };
}

/** Relative relevance for MCP/CLI output (top hit in a batch is always 100%). */
export function formatRelevanceScore(score: number, maxScore: number): string {
  if (maxScore <= 0) {
    return "0%";
  }
  const pct = Math.round((score / maxScore) * 100);
  return `${pct}%`;
}

export function formatResults(
  query: string,
  results: SearchResult[],
  options?: { repoRoot?: string | null; snippet?: boolean },
): { query: string; results: Record<string, unknown>[] } {
  const repoRoot = options?.repoRoot ?? null;
  const useSnippet = options?.snippet ?? searchSnippetsEnabled();
  const payload = useSnippet ? applySnippetsToResults(results, query) : null;
  const maxScore = results.reduce((max, result) => Math.max(max, result.score), 0);

  return {
    query,
    results: results.map((result, index) => {
      const entry = payload?.[index];
      const chunk = entry?.result.chunk ?? result.chunk;
      const dict = chunkToResponseDict(chunk, repoRoot);
      const score = formatRelevanceScore(result.score, maxScore);
      if (entry?.meta.truncated) {
        return {
          chunk: {
            ...dict,
            truncated: true,
            anchor_line: entry.meta.anchor_line,
            full_start_line: entry.meta.full_start_line,
            full_end_line: entry.meta.full_end_line,
          },
          score,
        };
      }
      return {
        chunk: dict,
        score,
      };
    }),
  };
}

export function formatExpandResults(
  filePath: string,
  line: number,
  anchor: Chunk | null,
  expanded: Chunk[],
  options?: { repoRoot?: string | null; before?: number; after?: number },
): ExpandResults {
  const repoRoot = options?.repoRoot ?? null;
  const indexedPath = toIndexedFilePath(filePath, repoRoot) || filePath;

  return {
    file_path: indexedPath,
    line,
    chunk_count: expanded.length,
    anchor: anchor ? chunkToResponseDict(anchor, repoRoot) : null,
    chunks: expanded.map((chunk) => chunkToResponseDict(chunk, repoRoot)),
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
