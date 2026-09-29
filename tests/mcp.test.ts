import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getIndexForRepo,
  IndexCache,
  mcpWatchEnabled,
  shouldIgnoreWatchPath,
} from "../src/mcp/index-cache.ts";
import type { MiruIndex } from "../src/miru-index.ts";

describe("IndexCache", () => {
  test("caches a local build, starts one watcher, and closes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-cache-"));
    const oldWatch = process.env.MIRU_MCP_WATCH;
    process.env.MIRU_MCP_WATCH = "1";
    let builds = 0;
    let watchCalls = 0;
    let closes = 0;
    const applied: string[][] = [];
    let onEvent: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const fakeIndex = {
      root: null,
      loadedFromDisk: false,
      async applyFileChanges(paths: string[]) {
        applied.push(paths);
      },
      async saveToCache() {},
    } as unknown as MiruIndex;
    const cache = new IndexCache(["code"], null, {
      fromSource: async () => {
        builds++;
        return fakeIndex;
      },
      watch: ((_path: string, _options: { recursive: boolean }, listener: typeof onEvent) => {
        watchCalls++;
        onEvent = listener;
        return {
          close: () => {
            closes++;
          },
        };
      }) as never,
    });
    try {
      expect(await cache.get(root)).toBe(fakeIndex);
      expect(await cache.get(root)).toBe(fakeIndex);
      cache.startWatcher(root);
      onEvent?.("change", null);
      onEvent?.("change", "node_modules/generated.ts");
      onEvent?.("change", "src/updated.ts");
      await Bun.sleep(0);
      await cache.get(root);
      expect(applied).toEqual([["src/updated.ts"]]);
      expect(builds).toBe(1);
      expect(watchCalls).toBe(1);
      cache.close();
      expect(closes).toBe(1);
      expect(cache.watcher).toBeNull();
      onEvent?.("change", "src/after-close.ts");
    } finally {
      cache.close();
      await rm(root, { recursive: true, force: true });
      if (oldWatch === undefined) delete process.env.MIRU_MCP_WATCH;
      else process.env.MIRU_MCP_WATCH = oldWatch;
    }
  });

  test("reconciles changed, deleted, and newly discovered disk files", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-stale-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "changed.ts"), "export const changed = true;\n");
    await writeFile(join(root, "src", "new.ts"), "export const created = true;\n");
    const oldWatch = process.env.MIRU_MCP_WATCH;
    process.env.MIRU_MCP_WATCH = "0";
    const applied: string[][] = [];
    let saved = 0;
    const fakeIndex = {
      root,
      loadedFromDisk: true,
      contentTypes: ["code"],
      getStoredFileMtimes: () =>
        new Map([
          ["src/changed.ts", 0],
          ["src/deleted.ts", 0],
        ]),
      async applyFileChanges(paths: string[]) {
        applied.push(paths);
      },
      async saveToCache() {
        saved++;
      },
    } as unknown as MiruIndex;
    const cache = new IndexCache(["code"], null, { fromSource: async () => fakeIndex });
    try {
      expect(await cache.get(root)).toBe(fakeIndex);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toEqual(
        expect.arrayContaining(["src/changed.ts", "src/deleted.ts", "src/new.ts"]),
      );
      expect(saved).toBe(2); // initial build plus reconciled update
    } finally {
      cache.close();
      await rm(root, { recursive: true, force: true });
      if (oldWatch === undefined) delete process.env.MIRU_MCP_WATCH;
      else process.env.MIRU_MCP_WATCH = oldWatch;
    }
  });

  test("handles recursive watcher setup failure and evicts the least-recent cache entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-eviction-"));
    const oldWatch = process.env.MIRU_MCP_WATCH;
    process.env.MIRU_MCP_WATCH = "1";
    let closes = 0;
    const fakeIndex = {
      root: null,
      loadedFromDisk: false,
      async saveToCache() {},
    } as unknown as MiruIndex;
    const cache = new IndexCache(["code"], null, {
      fromSource: async () => fakeIndex,
      watch: (() => {
        throw new Error("recursive watch unsupported");
      }) as never,
    });
    try {
      const brokenWatch = new IndexCache(["code"], null, {
        fromSource: async () => fakeIndex,
        watch: (() => {
          throw new Error("recursive watch unsupported");
        }) as never,
      });
      await brokenWatch.get(join(root, "broken"));
      expect(brokenWatch.watcher).not.toBeNull();
      brokenWatch.close();

      const evictionCache = new IndexCache(["code"], null, {
        fromSource: async () => fakeIndex,
        watch: (() => ({
          close: () => {
            closes++;
          },
        })) as never,
      });
      for (let i = 0; i < 11; i++) {
        await evictionCache.get(join(root, `repo-${i}`));
      }
      expect(closes).toBe(1);
      evictionCache.close();
    } finally {
      cache.close();
      await rm(root, { recursive: true, force: true });
      if (oldWatch === undefined) delete process.env.MIRU_MCP_WATCH;
      else process.env.MIRU_MCP_WATCH = oldWatch;
    }
  });

  test("clears a failed background build so a later get can retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-index-build-failure-"));
    const cache = new IndexCache(["code"], null, {
      fromSource: async () => {
        throw new Error("index build failed");
      },
    });
    try {
      await expect(cache.get(root)).rejects.toThrow("index build failed");
      await Bun.sleep(0);
      const entries = (
        cache as unknown as { entries: Map<string, { task: unknown; index: unknown }> }
      ).entries;
      const entry = entries.get(root);
      expect(entry?.task).toBeNull();
      expect(entry?.index).toBeNull();
    } finally {
      cache.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("getIndexForRepo requires repo", async () => {
    const cache = new IndexCache();
    await expect(getIndexForRepo(null, cache)).rejects.toThrow(/Pass an https:\/\//);
  });

  test("getIndexForRepo rejects unsafe git transport schemes", async () => {
    const cache = new IndexCache();
    await expect(getIndexForRepo("git@github.com:org/repo", cache)).rejects.toThrow(
      /Only https:\/\//,
    );
  });

  test("shouldIgnoreWatchPath skips noisy directories", () => {
    expect(shouldIgnoreWatchPath("node_modules/foo/index.js")).toBe(true);
    expect(shouldIgnoreWatchPath(".git/HEAD")).toBe(true);
    expect(shouldIgnoreWatchPath("src/index.ts")).toBe(false);
    expect(shouldIgnoreWatchPath(null)).toBe(false);
  });

  test("mcpWatchEnabled respects MIRU_MCP_WATCH=0", () => {
    const prev = process.env.MIRU_MCP_WATCH;
    process.env.MIRU_MCP_WATCH = "0";
    expect(mcpWatchEnabled()).toBe(false);
    process.env.MIRU_MCP_WATCH = prev;
  });
});
