import { watch } from "node:fs";
import { relative, resolve } from "node:path";
import { isCredentialsError } from "../auth/errors.ts";
import { walkFiles } from "../index/file-walker.ts";
import { getExtensions } from "../index/files.ts";
import { normalizeRelativePath, relativePathFromRoot } from "../index/incremental.ts";
import { MiruIndex } from "../miru-index.ts";
import { type ContentType, defaultContentTypes } from "../types.ts";
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

type WatcherHandle = { close(): void };

type CacheEntry = {
  source: string;
  index: MiruIndex | null;
  task: Promise<MiruIndex> | null;
  pendingPaths: Set<string>;
  flushQueued: boolean;
  updateChain: Promise<void>;
  /** Dead-credentials failure from a background re-embed; `get()` throws it until a retry clears it. */
  lastError: Error | null;
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

/**
 * Session cache of MiruIndex instances. Keeps them fresh by reconciling
 * mtimes on load (`checkAndQueueStaleFiles`) and applying incremental
 * updates from fs.watch (`flushFileUpdates` / `applyFileChanges`).
 */
export class IndexCache {
  private readonly content: ContentType[];
  private readonly defaultRef: string | null;
  private readonly entries = new Map<string, CacheEntry>();
  readonly watchers = new Map<string, WatcherHandle>();

  constructor(content: ContentType[] = defaultContentTypes(), defaultRef: string | null = null) {
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
        lastError: null,
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
    const entry = this.ensureEntry(cacheKey, source);
    const task = (async () => {
      const index = await MiruIndex.fromSource(source, this.content, undefined, ref);
      if (!isGitUrl(source)) {
        await index.saveToCache(resolve(source));
      }
      // Publish before stale reconciliation so flushFileUpdates can use
      // entry.index instead of awaiting this same task (self-deadlock).
      entry.index = index;
      if (index.loadedFromDisk) {
        // Await reconciliation here (not fire-and-forget) so callers of `get()`
        // never observe an index that's stale relative to what's on disk.
        await this.checkAndQueueStaleFiles(source, index, cacheKey);
      }
      return index;
    })();

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
          entry.index = null;
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
    if (entry.lastError) {
      throw entry.lastError;
    }
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

  private noteFileChange(source: string, filename: string | null | undefined): void {
    if (!filename) {
      // macOS recursive fs.watch could omit the filename on old Bun releases (pre-1.3.14
      // fs.watch rewrite); confirmed fixed on current Bun. No reconcile fallback for
      // this case anymore -- an event with no filename is simply dropped.
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

  private flushFileUpdates(
    cacheKey: string,
    source: string,
    knownIndex?: MiruIndex,
  ): Promise<void> {
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

      const requeue = (err?: unknown): void => {
        if (err !== undefined && isCredentialsError(err)) {
          entry.lastError = err instanceof Error ? err : new Error(String(err));
        }
        for (const p of paths) {
          entry.pendingPaths.add(p);
        }
      };

      // Prefer an index already in hand (or published on the entry). Never await
      // entry.task while that task is itself waiting on this flush — that deadlocks.
      let index = knownIndex ?? entry.index;
      if (!index && entry.task) {
        try {
          index = await entry.task;
        } catch (err) {
          requeue(err);
          return;
        }
      }
      if (!index) {
        requeue();
        return;
      }

      try {
        await index.applyFileChanges(paths);
      } catch (err) {
        requeue(err);
        return;
      }
      entry.lastError = null;
      if (!isGitUrl(source)) {
        try {
          await index.saveToCache(resolve(source), { force: true });
        } catch {
          // The in-memory index is already current. A cache write failure must
          // not requeue the change and repeatedly re-embed the same file.
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
        await this.flushFileUpdates(cacheKey, source, index);
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

    let nativeWatcher: ReturnType<typeof watch> | null = null;
    try {
      nativeWatcher = watch(resolved, { recursive: true }, (_event, filename) => {
        this.noteFileChange(path, filename);
      });
    } catch {
      // Recursive fs.watch is unavailable on some platforms (no fallback here
      // anymore -- such a local index will only refresh on next cold load).
    }

    this.watchers.set(resolved, {
      close: () => {
        nativeWatcher?.close();
      },
    });
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
    // Keep `cause` so the tool boundary can still recognize a credentials failure.
    throw new Error(`Failed to index ${repo}: ${message}`, { cause: err });
  }
}

export function toolText(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}
