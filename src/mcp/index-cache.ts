import { watch } from "node:fs";
import { relative, resolve } from "node:path";
import { walkFiles } from "../index/file-walker.ts";
import { getExtensions } from "../index/files.ts";
import { normalizeRelativePath, relativePathFromRoot } from "../index/incremental.ts";
import { MiruIndex } from "../miru-index.ts";
import type { ContentType } from "../types.ts";
import {
  computeSourceCacheKey,
  isAllowedRepoSource,
  isGitUrl,
  validateLocalRepoPath,
} from "../utils.ts";

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

type WatcherHandle = ReturnType<typeof watch>;

type CacheEntry = {
  source: string;
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
  readonly watchers = new Map<string, WatcherHandle>();

  constructor(content: ContentType[] = ["code"], defaultRef: string | null = null) {
    this.content = content;
    this.defaultRef = defaultRef;
  }

  private ensureEntry(cacheKey: string, source: string): CacheEntry {
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      if (this.entries.size >= CACHE_MAX_SIZE) {
        const oldest = this.entries.keys().next().value;
        if (oldest) {
          this.clearEntry(oldest);
        }
      }
      entry = {
        source,
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
    const entry = this.entries.get(cacheKey);
    if (entry && !isGitUrl(entry.source)) {
      this.stopWatcher(resolve(entry.source));
    }
    this.entries.delete(cacheKey);
  }

  private stopWatcher(resolvedPath: string): void {
    const watcher = this.watchers.get(resolvedPath);
    watcher?.close();
    this.watchers.delete(resolvedPath);
  }

  private startBuild(
    source: string,
    ref: string | null | undefined,
    cacheKey: string,
  ): Promise<MiruIndex> {
    const task = (async () => {
      const index = await MiruIndex.fromSource(source, this.content, undefined, ref);
      if (!isGitUrl(source)) {
        await index.saveToCache(resolve(source));
      }
      if (index.loadedFromDisk) {
        // Await reconciliation here (not fire-and-forget) so callers of `get()`
        // never observe an index that's stale relative to what's on disk.
        await this.checkAndQueueStaleFiles(source, index, cacheKey);
      }
      return index;
    })();

    const entry = this.ensureEntry(cacheKey, source);
    entry.task = task;
    void task
      .then((index) => {
        entry.index = index;
        this.maybeStartWatcher(source);
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
    const entry = this.ensureEntry(cacheKey, source);

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
        void this.flushFileUpdates(cacheKey, source);
      });
    }
  }

  private queueIndexedPaths(source: string, index: MiruIndex): void {
    const cacheKey = computeSourceCacheKey(source);
    const entry = this.ensureEntry(cacheKey, source);
    for (const chunk of index.chunks) {
      entry.pendingPaths.add(normalizeRelativePath(chunk.file_path));
    }
    this.scheduleFlush(cacheKey, source, entry);
  }

  /** macOS recursive fs.watch often omits filename; refresh all indexed paths incrementally. */
  private noteAmbiguousDirectoryChange(source: string): void {
    const cacheKey = computeSourceCacheKey(source);
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return;
    }

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
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return;
    }
    const rel = relativePathFromRoot(source, filename);
    if (!rel) {
      return;
    }
    entry.pendingPaths.add(rel);
    this.scheduleFlush(cacheKey, source, entry);
  }

  private flushFileUpdates(cacheKey: string, source: string): Promise<void> {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return Promise.resolve();
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
          await index.saveToCache(resolve(source), { force: true });
        }
      } catch {
        for (const p of paths) {
          entry.pendingPaths.add(p);
        }
      }
    };

    entry.updateChain = entry.updateChain.then(run, run);
    return entry.updateChain;
  }

  private async checkAndQueueStaleFiles(
    source: string,
    index: MiruIndex,
    cacheKey: string,
  ): Promise<void> {
    if (isGitUrl(source)) {
      return;
    }

    const root = index.root;
    if (!root) {
      return;
    }

    const storedMtimes = index.getStoredFileMtimes();
    const entry = this.ensureEntry(cacheKey, source);

    try {
      await Promise.all(
        [...storedMtimes].map(async ([filePath, storedMtime]) => {
          try {
            const currentStat = await Bun.file(resolve(root, filePath)).stat();
            const currentMtime = Math.floor(currentStat.mtime?.getTime() ?? 0);

            if (currentMtime !== storedMtime) {
              entry.pendingPaths.add(normalizeRelativePath(filePath));
            }
          } catch {
            entry.pendingPaths.add(normalizeRelativePath(filePath));
          }
        }),
      );

      // Files created on disk while this index wasn't loaded (or never indexed
      // before) have no entry in `storedMtimes` and are otherwise invisible to
      // the mtime comparison above; a directory walk is the only way to find them.
      const extensions = getExtensions(index.contentTypes);
      for await (const absolutePath of walkFiles(root, extensions)) {
        const relativePath = normalizeRelativePath(relative(root, absolutePath));
        if (!storedMtimes.has(relativePath)) {
          entry.pendingPaths.add(relativePath);
        }
      }

      if (entry.pendingPaths.size > 0) {
        await this.flushFileUpdates(cacheKey, source);
      }
    } catch {}
  }

  private maybeStartWatcher(source: string): void {
    if (!mcpWatchEnabled() || isGitUrl(source)) {
      return;
    }
    this.startWatcher(source);
  }

  startWatcher(path: string): void {
    const resolved = resolve(path);
    if (this.watchers.has(resolved)) {
      return;
    }

    const watcher = watch(resolved, { recursive: true }, (_event, filename) => {
      this.noteFileChange(resolved, filename);
    });
    this.watchers.set(resolved, watcher);
  }

  get watcher(): WatcherHandle | null {
    const handles = [...this.watchers.values()];
    return handles[handles.length - 1] ?? null;
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
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

  validateLocalRepoPath(repo);

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
