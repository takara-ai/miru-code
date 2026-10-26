import { afterEach, expect, test } from "bun:test";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { StdioTransport } from "../src/mcp/stdio.ts";
import type { MiruIndex } from "../src/miru-index.ts";
import { computeSourceCacheKey } from "../src/utils.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const previousWatch = process.env.MIRU_MCP_WATCH;
afterEach(() => {
  if (previousWatch === undefined) delete process.env.MIRU_MCP_WATCH;
  else process.env.MIRU_MCP_WATCH = previousWatch;
});
function fixture() {
  let watches = 0,
    closes = 0,
    saves = 0;
  const index = {
    root: null,
    loadedFromDisk: false,
    async saveToCache() {
      saves++;
    },
  } as unknown as MiruIndex;
  const cache = new IndexCache(["code"], null, {
    fromSource: async () => index,
    watch: (() => {
      watches++;
      return {
        close() {
          closes++;
        },
      };
    }) as never,
  });
  return { cache, index, counts: () => ({ watches, closes, saves }) };
}

test("a build completing after cache close cannot resurrect a watcher", async () => {
  process.env.MIRU_MCP_WATCH = "1";
  const build = deferred<MiruIndex>();
  const f = fixture();
  let watches = 0;
  const cache = new IndexCache(["code"], null, {
    fromSource: () => build.promise,
    watch: (() => {
      watches++;
      return { close() {} };
    }) as never,
  });
  try {
    const pending = cache.get("/memory-lifecycle/pending");
    cache.close();
    build.resolve(f.index);
    expect(await pending).toBe(f.index);
    await Bun.sleep(0);
    expect(watches).toBe(0);
    expect(cache.watchers.size).toBe(0);
    expect(f.counts().saves).toBe(0);
  } finally {
    cache.close();
  }
});

test("an evicted pending build cannot resurrect its entry or watcher", async () => {
  process.env.MIRU_MCP_WATCH = "1";
  const build = deferred<MiruIndex>();
  const f = fixture();
  const cache = new IndexCache(["code"], null, {
    fromSource: (source) => (source.endsWith("pending") ? build.promise : Promise.resolve(f.index)),
    watch: (() => ({ close() {} })) as never,
  });
  try {
    const pending = cache.get("/memory-lifecycle/pending");
    for (let i = 0; i < 10; i++) await cache.get(`/memory-lifecycle/repo-${i}`);
    build.resolve(f.index);
    await pending;
    await Bun.sleep(0);
    expect(cache.watchers.size).toBe(10);
    expect(cache.watchers.has("/memory-lifecycle/pending")).toBe(false);
  } finally {
    cache.close();
  }
});

test("old builds cannot attach watchers to a replacement entry after cache reset", async () => {
  process.env.MIRU_MCP_WATCH = "1";
  const builds = [deferred<MiruIndex>(), deferred<MiruIndex>()];
  const f = fixture();
  let calls = 0,
    watches = 0;
  const cache = new IndexCache(["code"], null, {
    fromSource: () => (builds[calls++] as ReturnType<typeof deferred<MiruIndex>>).promise,
    watch: (() => {
      watches++;
      return { close() {} };
    }) as never,
  });
  try {
    const first = cache.get("/memory-lifecycle/reused");
    cache.close();
    const second = cache.get("/memory-lifecycle/reused");
    builds[0]?.resolve(f.index);
    await first;
    await Bun.sleep(0);
    expect(watches).toBe(0);
    builds[1]?.resolve(f.index);
    await second;
    expect(watches).toBe(1);
  } finally {
    cache.close();
  }
});

test("queued file updates stop when their cache entry is closed", async () => {
  process.env.MIRU_MCP_WATCH = "0";
  const f = fixture();
  let applied = 0;
  f.index.applyFileChanges = async () => {
    applied++;
  };
  await f.cache.get("/memory-lifecycle/updates");
  const internals = f.cache as unknown as {
    entries: Map<string, { pendingPaths: Set<string>; updateChain: Promise<void> }>;
    flushFileUpdates(key: string, source: string): Promise<void>;
  };
  const key = computeSourceCacheKey("/memory-lifecycle/updates");
  internals.entries.get(key)?.pendingPaths.add("source.ts");
  const pending = internals.flushFileUpdates(key, "/memory-lifecycle/updates");
  f.cache.close();
  await pending;
  expect(applied).toBe(0);
});

test("file-change storms coalesce while an update is in flight", async () => {
  process.env.MIRU_MCP_WATCH = "0";
  const f = fixture();
  const gate = deferred<void>();
  const batches: string[][] = [];
  f.index.applyFileChanges = async (paths) => {
    batches.push([...paths]);
    if (batches.length === 1) await gate.promise;
  };
  const source = "/memory-lifecycle/storm";
  const internals = f.cache as unknown as {
    entries: Map<string, { updateChain: Promise<void> }>;
    noteFileChange(source: string, path: string): void;
  };
  try {
    await f.cache.get(source);
    internals.noteFileChange(source, "first.ts");
    await Bun.sleep(0);
    const current = internals.entries.get(computeSourceCacheKey(source))?.updateChain;
    for (let i = 0; i < 200; i++) {
      internals.noteFileChange(source, `change-${i}.ts`);
      await Promise.resolve();
    }
    expect(internals.entries.get(computeSourceCacheKey(source))?.updateChain).toBe(current);
    gate.resolve();
    await f.cache.get(source);
    expect(batches.map((batch) => batch.length)).toEqual([1, 200]);
  } finally {
    gate.resolve();
    f.cache.close();
  }
});

test("MCP EOF closes its cache and releases the message handler", async () => {
  process.env.MIRU_MCP_WATCH = "1";
  const f = fixture();
  await f.cache.get("/memory-lifecycle/session");
  const server = createMcpServer(f.cache);
  const transport = new MemoryTransport([]);
  await server.connect(transport);
  expect(f.counts().closes).toBe(1);
  expect(f.cache.watchers.size).toBe(0);
  expect(transport.onmessage).toBeUndefined();
  await server.close();
  expect(f.counts().closes).toBe(1);
});

test("a failed MCP connection releases its cache and preserves transport cleanup", async () => {
  process.env.MIRU_MCP_WATCH = "1";
  const f = fixture();
  await f.cache.get("/memory-lifecycle/failed-session");
  const server = createMcpServer(f.cache);
  const transport = new (class extends StdioTransport {
    override async start() {
      throw Error("transport startup failed");
    }
  })();
  let closed = 0;
  transport.onclose = () => {
    closed++;
  };
  await expect(server.connect(transport)).rejects.toThrow("startup failed");
  expect(f.counts().closes).toBe(1);
  expect(closed).toBe(1);
  expect(transport.onmessage).toBeUndefined();
  await server.close();
  expect(closed).toBe(1);
});

test("explicit MCP close cancels an idle connection and rejects simultaneous connections", async () => {
  const f = fixture();
  const server = createMcpServer(f.cache);
  const stream = new ReadableStream<Uint8Array>();
  const transport = new StdioTransport({ inputStream: () => stream });
  const running = server.connect(transport);
  await expect(server.connect(new MemoryTransport([]))).rejects.toThrow("already connected");
  await server.close();
  await running;
  expect(transport.onmessage).toBeUndefined();
  expect(stream.locked).toBe(false);
});

test("closing an idle stdio reader cancels it and settles start exactly once", async () => {
  let canceled = 0,
    closed = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled++;
    },
  });
  const transport = new StdioTransport({ inputStream: () => stream });
  transport.onclose = () => {
    closed++;
  };
  const running = transport.start();
  await transport.close();
  await Promise.race([
    running,
    Bun.sleep(100).then(() => {
      throw Error("reader still pending");
    }),
  ]);
  await transport.close();
  expect(canceled).toBe(1);
  expect(closed).toBe(1);
  expect(stream.locked).toBe(false);
});
