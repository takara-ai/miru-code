import { watch } from "node:fs";
import { resolve } from "node:path";
import { normalizeRelativePath, relativePathFromRoot } from "../index/incremental.ts";
import { MiruIndex } from "../miru-index.ts";
import type { ContentType } from "../types.ts";
import { computeSourceCacheKey, isAllowedRepoSource, isGitUrl } from "../utils.ts";

const CACHE_MAX_SIZE = 10;

/** Directory names we skip for MCP fs.watch update triggers (aligned with file-walker). */
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

type CacheEntry = {
  index: MiruIndex | null;
  task: Promise<MiruIndex> | null;
  pendingPaths: Set<string>;
  flushQueued: boolean;
  updateChain: Promise<void>;
};

export function mcpWatchEnabled(): boolean {
  const raw = process.env.MIRU_MCP_WATCH;
  return raw !== "0" && raw !== "false";
}

/** Returns true when a watch event path should not trigger an update. */
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
  private readonly defaultRef: string | null;
  private readonly entries = new Map<string, CacheEntry>();
  private watcher: ReturnType<typeof watch> | null = null;
  private watchedSource: string | null = null;

  constructor(content: ContentType[] = ["code"], defaultRef: string | null = null) {
    this.content = content;
    this.defaultRef = defaultRef;
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
      entry = {
        index: null,
        task: null,
        pendingPaths: new Set(),
        flushQueued: false,
        updateChain: Promise.resolve(),
      };
      this.entries.set(cacheKey, entry);
    }
    return entry;
  }

  private clearEntry(cacheKey: string): void {
    this.entries.delete(cacheKey);
  }

  private startBuild(
    source: string,
    ref: string | null | undefined,
    cacheKey: string,
  ): Promise<MiruIndex> {
    const task = (async () => {
      const index = await MiruIndex.fromSource(source, this.content, undefined, ref);
      if (!isGitUrl(source)) {
        await index.saveToDefaultCache(resolve(source));
      }
      return index;
    })();

    const entry = this.ensureEntry(cacheKey);
    entry.task = task;
    void task
      .then((index) => {
        entry.index = index;
        this.maybeStartWatcher(source);
        void this.flushFileUpdates(cacheKey, source);
        return index;
      })
      .catch(() => {
        if (entry.task === task) {
          entry.task = null;
        }
      });

    return task;
  }

  async get(source: string, ref?: string | null): Promise<MiruIndex> {
    const resolvedRef = ref ?? this.defaultRef;
    const cacheKey = computeSourceCacheKey(source, resolvedRef);
    const entry = this.ensureEntry(cacheKey);

    if (!entry.task) {
      this.startBuild(source, resolvedRef, cacheKey);
    }

    const index = await entry.task;
    if (!index) {
      throw new Error(`Failed to load index for ${source}`);
    }
    await entry.updateChain;
    return index;
  }

  private scheduleFlush(cacheKey: string, source: string, entry: CacheEntry): void {
    if (!entry.flushQueued) {
      entry.flushQueued = true;
      queueMicrotask(() => {
        this.flushFileUpdates(cacheKey, source);
      });
    }
  }

  private queueIndexedPaths(source: string, index: MiruIndex): void {
    const cacheKey = computeSourceCacheKey(source);
    const entry = this.ensureEntry(cacheKey);
    for (const chunk of index.chunks) {
      entry.pendingPaths.add(normalizeRelativePath(chunk.file_path));
    }
    this.scheduleFlush(cacheKey, source, entry);
  }

  /** macOS recursive fs.watch often omits filename; refresh all indexed paths incrementally. */
  private noteAmbiguousDirectoryChange(source: string): void {
    const cacheKey = computeSourceCacheKey(source);
    const entry = this.ensureEntry(cacheKey);

    if (entry.index) {
      this.queueIndexedPaths(source, entry.index);
      return;
    }

    if (entry.task) {
      void entry.task.then((index) => {
        entry.index = index;
        this.queueIndexedPaths(source, index);
      });
    }
  }

  private noteFileChange(source: string, filename: string | null | undefined): void {
    if (!filename) {
      this.noteAmbiguousDirectoryChange(source);
      return;
    }
    if (shouldIgnoreWatchPath(filename)) {
      return;
    }

    const cacheKey = computeSourceCacheKey(source);
    const entry = this.ensureEntry(cacheKey);
    const rel = relativePathFromRoot(source, filename);
    if (!rel) {
      return;
    }
    entry.pendingPaths.add(rel);
    this.scheduleFlush(cacheKey, source, entry);
  }

  private flushFileUpdates(cacheKey: string, source: string): void {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return;
    }
    entry.flushQueued = false;

    const run = async (): Promise<void> => {
      const paths = [...entry.pendingPaths];
      entry.pendingPaths.clear();
      if (paths.length === 0) {
        return;
      }

      let index = entry.index;
      if (!index && entry.task) {
        try {
          index = await entry.task;
        } catch {
          for (const p of paths) {
            entry.pendingPaths.add(p);
          }
          return;
        }
      }
      if (!index) {
        for (const p of paths) {
          entry.pendingPaths.add(p);
        }
        return;
      }

      try {
        await index.applyFileChanges(paths);
        if (!isGitUrl(source)) {
          await index.persistToCache(resolve(source));
        }
      } catch {
        for (const p of paths) {
          entry.pendingPaths.add(p);
        }
      }
    };

    entry.updateChain = entry.updateChain.then(run, run);
  }

  private maybeStartWatcher(source: string): void {
    if (!mcpWatchEnabled() || isGitUrl(source)) {
      return;
    }
    const resolved = resolve(source);
    if (this.watchedSource === resolved) {
      return;
    }
    this.watchedSource = resolved;
    this.startWatcher(resolved);
  }

  startWatcher(path: string): void {
    const resolved = resolve(path);
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = watch(resolved, { recursive: true }, (_event, filename) => {
      this.noteFileChange(resolved, filename);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedSource = null;
    this.entries.clear();
  }
}

export async function getIndexForRepo(
  repo: string | null | undefined,
  cache: IndexCache,
  ref?: string | null,
): Promise<MiruIndex> {
  if (!repo) {
    throw new Error(
      "Pass an https:// or http:// git URL or local directory path as `repo` (project root for local workspaces).",
    );
  }

  if (isGitUrl(repo) && !isAllowedRepoSource(repo)) {
    if (repo.startsWith("http://")) {
      throw new Error(
        "Plain http:// git URLs are disabled by default. Set MIRU_ALLOW_HTTP_GIT=1 to opt in.",
      );
    }
    throw new Error(
      `Only https:// git URLs or local directory paths are accepted as \`repo\`. Got: ${repo}`,
    );
  }

  try {
    return await cache.get(repo, ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to index ${repo}: ${message}`);
  }
}

export function toolText(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}
