import { watch } from "node:fs";
import { resolve } from "node:path";
import { MiruIndex } from "../miru-index.ts";
import type { ContentType } from "../types.ts";
import { computeSourceCacheKey, isGitUrl } from "../utils.ts";

const CACHE_MAX_SIZE = 10;

type IndexTask = Promise<MiruIndex>;

export class IndexCache {
  private readonly content: ContentType[];
  private readonly tasks = new Map<string, IndexTask>();
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(content: ContentType[] = ["code"]) {
    this.content = content;
  }

  evict(source: string, ref?: string | null): void {
    this.tasks.delete(computeSourceCacheKey(source, ref));
  }

  async get(source: string, ref?: string | null): Promise<MiruIndex> {
    const cacheKey = computeSourceCacheKey(source, ref);
    let task = this.tasks.get(cacheKey);
    if (!task) {
      if (this.tasks.size >= CACHE_MAX_SIZE) {
        const oldest = this.tasks.keys().next().value;
        if (oldest) {
          this.tasks.delete(oldest);
        }
      }
      task = MiruIndex.fromSource(source, this.content, undefined, ref);
      this.tasks.set(cacheKey, task);
    }

    try {
      return await task;
    } catch (err) {
      if (this.tasks.get(cacheKey) === task) {
        this.tasks.delete(cacheKey);
      }
      throw err;
    }
  }

  startWatcher(path: string): void {
    const resolved = resolve(path);
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = watch(resolved, { recursive: true }, () => {
      this.evict(resolved);
      void this.get(resolved).catch(() => undefined);
    });
  }

  close(): void {
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
