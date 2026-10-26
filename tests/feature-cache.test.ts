import { expect, test } from "bun:test";
import { ChunkFeatureCache } from "../src/ranking/feature-cache.ts";
import type { Chunk } from "../src/types.ts";

const chunk = (content: string): Chunk => ({
  content,
  file_path: "test.ts",
  language: "typescript",
  start_line: 1,
  end_line: 1,
});

test("feature metadata does not keep a discarded chunk alive, including value-to-key cycles", async () => {
  const moduleUrl = new URL("../src/ranking/feature-cache.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { ChunkFeatureCache } from ${JSON.stringify(moduleUrl)};
    const cache = new ChunkFeatureCache();
    const ref = (() => {
      const chunk = {content: 'example', file_path: 'example.ts'};
      cache.set(chunk, {owner: chunk});
      return new WeakRef(chunk);
    })();
    for (let i = 0; i < 10; i++) { await Bun.sleep(0); Bun.gc(true); }
    if (ref.deref()) throw Error('Cache retained a discarded chunk');
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("feature cache caps live chunks, token entries and source characters independently", () => {
  const first = chunk("aaa"),
    second = chunk("bbb"),
    third = chunk("ccc");
  for (const limits of [
    { chunks: 2, tokens: 100, characters: 100 },
    { chunks: 100, tokens: 4, characters: 100 },
    { chunks: 100, tokens: 100, characters: 6 },
  ]) {
    const cache = new ChunkFeatureCache<number>(limits);
    cache.set(first, 1, 2);
    cache.set(second, 2, 2);
    cache.set(third, 3, 2);
    expect(cache.size).toBe(2);
    expect(cache.get(first)).toBeUndefined();
    expect(cache.get(second)).toBe(2);
    expect(cache.get(third)).toBe(3);
  }
});

test("feature cache replaces metadata without double counting and skips oversized entries", () => {
  const cache = new ChunkFeatureCache<number>({ chunks: 2, tokens: 4, characters: 6 });
  const first = chunk("aaa"),
    second = chunk("bbb");
  cache.set(first, 1, 2);
  cache.set(first, 2, 2);
  cache.set(second, 3, 2);
  expect(cache.size).toBe(2);
  expect(cache.get(first)).toBe(2);
  cache.set(first, 4, 5);
  expect(cache.get(first)).toBeUndefined();
  cache.set(chunk("oversized"), 5);
  expect(cache.size).toBe(1);
  cache.delete(second);
  cache.delete(second);
  expect(cache.size).toBe(0);
  cache.set(first, 6);
  cache.clear();
  expect(cache.get(first)).toBeUndefined();
  expect(cache.size).toBe(0);
});
