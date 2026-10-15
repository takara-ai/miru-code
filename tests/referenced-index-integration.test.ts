import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { ReferencedVectorIndex } from "../src/index/referenced-index.ts";
import { MiruIndex } from "../src/miru-index.ts";

const MODEL = "fake-referenced-model";
const DIMS = 16;

function fakeVector(text: string): Float32Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  const bytes = hasher.digest();
  const v = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    v[i] = (bytes[i] as number) - 127.5;
    norm += (v[i] as number) ** 2;
  }
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

function fakeBackend(embedded: string[]): EmbeddingBackend {
  return {
    model: MODEL,
    dimensions: DIMS,
    embedDocuments: async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(fakeVector);
    },
    embedQuery: async (text: string) => fakeVector(text),
  };
}

let tmp = "";
let prevCache: string | undefined;
let prevFloat: string | undefined;

beforeEach(async () => {
  prevCache = process.env.MIRU_CACHE_HOME;
  prevFloat = process.env.MIRU_FLOAT_VECTORS;
  delete process.env.MIRU_FLOAT_VECTORS;
  tmp = await mkdtemp(join(tmpdir(), "miru-referenced-"));
  process.env.MIRU_CACHE_HOME = join(tmp, "cache");
});

afterEach(async () => {
  if (prevCache === undefined) delete process.env.MIRU_CACHE_HOME;
  else process.env.MIRU_CACHE_HOME = prevCache;
  if (prevFloat === undefined) delete process.env.MIRU_FLOAT_VECTORS;
  else process.env.MIRU_FLOAT_VECTORS = prevFloat;
  await rm(tmp, { recursive: true, force: true });
});

async function build(dir: string, embedded: string[]): Promise<MiruIndex> {
  return MiruIndex.fromPath(dir, undefined, MODEL, {
    getValidatedCache: async () => null,
    getEmbeddingBackend: () => fakeBackend(embedded),
  });
}

describe("referenced vector index integration", () => {
  test("second index over identical content embeds nothing; incremental embeds only new text", async () => {
    const a = join(tmp, "a");
    await mkdir(a, { recursive: true });
    await writeFile(
      join(a, "alpha.ts"),
      "export function alpha(x: number) {\n  return x + 1;\n}\n",
    );
    await writeFile(
      join(a, "beta.ts"),
      "export function beta(y: string) {\n  return y.trim();\n}\n",
    );
    const b = join(tmp, "b");
    await cp(a, b, { recursive: true });

    const firstCalls: string[] = [];
    const first = await build(a, firstCalls);
    expect(firstCalls.length).toBeGreaterThan(0);

    const secondCalls: string[] = [];
    const second = await build(b, secondCalls);
    expect(secondCalls).toEqual([]);

    const query = "alpha function";
    const r1 = await first.search({ query, rerank: false });
    const r2 = await second.search({ query, rerank: false });
    const summarize = (rs: typeof r1) => rs.map((r) => [r.chunk.content, r.score]);
    expect(summarize(r2)).toEqual(summarize(r1));

    // Modify one file in the copy and apply incrementally.
    const semanticBefore = (second as unknown as { semanticIndex: ReferencedVectorIndex })
      .semanticIndex;
    expect(semanticBefore).toBeInstanceOf(ReferencedVectorIndex);
    const betaIdx = second.chunks.findIndex((c) => c.file_path.endsWith("beta.ts"));
    const alphaIdx = second.chunks.findIndex((c) => c.file_path.endsWith("alpha.ts"));
    const alphaRefBefore = semanticBefore.refAt(alphaIdx);
    expect(betaIdx).toBeGreaterThanOrEqual(0);

    await writeFile(
      join(b, "beta.ts"),
      "export function beta(y: string) {\n  return y.toUpperCase();\n}\n",
    );
    const incCalls: string[] = [];
    (second as unknown as { embeddings: EmbeddingBackend }).embeddings.embedDocuments = async (
      texts: string[],
    ) => {
      incCalls.push(...texts);
      return texts.map(fakeVector);
    };
    await second.applyFileChanges(["beta.ts"]);

    expect(incCalls.length).toBe(1);
    expect(incCalls[0]).toContain("toUpperCase");
    const semanticAfter = (second as unknown as { semanticIndex: ReferencedVectorIndex })
      .semanticIndex;
    expect(semanticAfter).toBeInstanceOf(ReferencedVectorIndex);
    const newAlphaIdx = second.chunks.findIndex((c) => c.file_path.endsWith("alpha.ts"));
    expect(semanticAfter.refAt(newAlphaIdx)).toEqual(alphaRefBefore);
    const alphaHashBefore = semanticBefore.hashes.slice(alphaIdx * 32, alphaIdx * 32 + 32);
    const alphaHashAfter = semanticAfter.hashes.slice(newAlphaIdx * 32, newAlphaIdx * 32 + 32);
    expect(alphaHashAfter).toEqual(alphaHashBefore);
  });

  test("incremental edits in one worktree do not affect another, in memory or after cache reload", async () => {
    const a = join(tmp, "a");
    await mkdir(a, { recursive: true });
    await writeFile(
      join(a, "beta.ts"),
      "export function beta(y: string) {\n  return y.trim();\n}\n",
    );
    const b = join(tmp, "b");
    await cp(a, b, { recursive: true });

    const first = await build(a, []);
    const second = await build(b, []);
    await first.saveToCache(a);
    await second.saveToCache(b);

    const summarize = async (index: MiruIndex, query: string) =>
      (await index.search({ query, rerank: false })).map((r) => [r.chunk.content, r.score]);
    const before = await summarize(first, "trim the string");
    expect(JSON.stringify(before)).toContain("trim()");

    // Rewrite b's file so the text a still depends on ("trim") is gone from b.
    await writeFile(
      join(b, "beta.ts"),
      "export function beta(y: string) {\n  return y.toUpperCase();\n}\n",
    );
    (second as unknown as { embeddings: EmbeddingBackend }).embeddings = fakeBackend([]);
    await second.applyFileChanges(["beta.ts"]);
    await second.saveToCache(b, { force: true });

    // a, still in memory, is unchanged.
    expect(await summarize(first, "trim the string")).toEqual(before);

    // a reloaded from the cache (real validation, no embedding allowed) is unchanged.
    const reloadCalls: string[] = [];
    const reloadedA = await MiruIndex.fromPath(a, undefined, MODEL, {
      getEmbeddingBackend: () => fakeBackend(reloadCalls),
    });
    expect(reloadedA.loadedFromDisk).toBe(true);
    expect(await summarize(reloadedA, "trim the string")).toEqual(before);

    // b reloaded from the cache sees its own edit and not a's text.
    const reloadedB = await MiruIndex.fromPath(b, undefined, MODEL, {
      getEmbeddingBackend: () => fakeBackend(reloadCalls),
    });
    expect(reloadedB.loadedFromDisk).toBe(true);
    const bText = JSON.stringify(await summarize(reloadedB, "uppercase the string"));
    expect(bText).toContain("toUpperCase");
    expect(bText).not.toContain("trim()");
    expect(reloadCalls).toEqual([]);
  });
});
