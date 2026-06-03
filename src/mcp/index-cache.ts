import { watch } from "node:fs";
import { resolve } from "node:path";
import { MiruIndex } from "../miru-index.ts";
import { envOptionalInt } from "../env.ts";
import type { ContentType } from "../types.ts";
import { computeSourceCacheKey, isGitUrl } from "../utils.ts";

const CACHE_MAX_SIZE = 10;
const DEFAULT_REINDEX_DEBOUNCE_MS = 3000;

/** Directory names we skip for MCP fs.watch re-index triggers (aligned with file-walker). */
const WATCH_IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".miru",
  ".next",
  "dist",
  "build",
  ".eggs",
]);

class StaleIndexError extends Error {
  constructor() {
    super("Index build superseded by a newer change");
    this.name = "StaleIndexError";
  }
}

type CacheEntry = {
  generation: number;
  task: Promise<MiruIndex> | null;
};

function resolveReindexDebounceMs(): number {
  return envOptionalInt(["MIRU_MCP_REINDEX_DEBOUNCE_MS"], 0) ?? DEFAULT_REINDEX_DEBOUNCE_MS;
}

export function mcpWatchEnabled(): boolean {
  const raw = process.env.MIRU_MCP_WATCH ?? process.env.SEMBLE_MCP_WATCH;
  return raw !== "0" && raw !== "false";
}

/** Returns true when a watch event path should not trigger a re-index. */
export function shouldIgnoreWatchPath(relativePath: string | null | undefined): boolean {
  if (!relativePath) {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment && WATCH_IGNORED_DIR_NAMES.has(segment)) {
      return true;
    }
  }
  return false;
}

export class IndexCache {
  private readonly content: ContentType[];
  private readonly entries = new Map<string, CacheEntry>();
  private readonly reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(content: ContentType[] = ["code"]) {
    this.content = content;
  }

  evict(source: string, ref?: string | null): void {
    this.invalidate(computeSourceCacheKey(source, ref));
  }

  private invalidate(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      entry.generation++;
      entry.task = null;
    }
  }

  private ensureEntry(cacheKey: string): CacheEntry {
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      if (this.entries.size >= CACHE_MAX_SIZE) {
        const oldest = this.entries.keys().next().value;
        if (oldest) {
          this.clearEntry(oldest);
        }
      }
      entry = { generation: 0, task: null };
      this.entries.set(cacheKey, entry);
    }
    return entry;
  }

  private clearEntry(cacheKey: string): void {
    const timer = this.reindexTimers.get(cacheKey);
    if (timer) {
      clearTimeout(timer);
      this.reindexTimers.delete(cacheKey);
    }
    this.entries.delete(cacheKey);
  }

  private startBuild(
    source: string,
    ref: string | null | undefined,
    entry: CacheEntry,
    generationAtStart: number,
  ): Promise<MiruIndex> {
    return (async () => {
      const index = await MiruIndex.fromSource(source, this.content, undefined, ref);
      if (entry.generation !== generationAtStart) {
        throw new StaleIndexError();
      }
      if (!isGitUrl(source)) {
        await index.saveToDefaultCache(resolve(source));
      }
      return index;
    })();
  }

  async get(source: string, ref?: string | null): Promise<MiruIndex> {
    const cacheKey = computeSourceCacheKey(source, ref);

    for (;;) {
      const entry = this.ensureEntry(cacheKey);
      const generationAtStart = entry.generation;

      if (!entry.task) {
        entry.task = this.startBuild(source, ref, entry, generationAtStart);
      }

      const task = entry.task;
      try {
        const index = await task;
        if (entry.generation !== generationAtStart) {
          continue;
        }
        return index;
      } catch (err) {
        if (entry.task === task) {
          entry.task = null;
        }
        if (err instanceof StaleIndexError) {
          continue;
        }
        if (this.entries.get(cacheKey) === entry) {
          this.entries.delete(cacheKey);
        }
        throw err;
      }
    }
  }

  private scheduleReindex(source: string, ref?: string | null): void {
    const cacheKey = computeSourceCacheKey(source, ref);
    const existing = this.reindexTimers.get(cacheKey);
    if (existing) {
      clearTimeout(existing);
    }

    const debounceMs = resolveReindexDebounceMs();
    const timer = setTimeout(() => {
      this.reindexTimers.delete(cacheKey);
      this.invalidate(cacheKey);
      void this.get(source, ref).catch(() => undefined);
    }, debounceMs);

    this.reindexTimers.set(cacheKey, timer);
  }

  startWatcher(path: string): void {
    const resolved = resolve(path);
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = watch(resolved, { recursive: true }, (_event, filename) => {
      if (shouldIgnoreWatchPath(filename)) {
        return;
      }
      this.scheduleReindex(resolved);
    });
  }

  close(): void {
    for (const timer of this.reindexTimers.values()) {
      clearTimeout(timer);
    }
    this.reindexTimers.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}

export async function getIndexForRepo(
  repo: string | null | undefined,
  defaultSource: string | null,
  cache: IndexCache,
  ref?: string | null,
): Promise<MiruIndex> {
  if (repo && isGitUrl(repo) && !repo.startsWith("https://") && !repo.startsWith("http://")) {
    throw new Error(
      `Only https://, http://, or local directory paths are accepted as \`repo\`. Got: ${repo}`,
    );
  }

  const source = repo ?? defaultSource;
  if (!source) {
    throw new Error(
      "No repo specified and no default index. Pass an https:// or http:// git URL or local directory path as `repo`.",
    );
  }

  try {
    return await cache.get(source, ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to index ${source}: ${message}`);
  }
}

export function toolText(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}
