/**
 * Where does time go in an incremental update, excluding embedding API latency?
 *
 *  1. Chunking K changed files: serial loop vs mapPool (what the incremental path could use).
 *  2. Fixed per-update cost at N indexed chunks: the keep-vectors pass plus the full BM25 and
 *     semantic-index rebuild that run after every flush, however small the edit.
 *
 *   bun run scripts/benchmark-incremental-timing.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { chunkSource } from "../src/chunking/chunking.ts";
import { mapPool, resolveWorkerConcurrency } from "../src/concurrency.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { walkFiles } from "../src/index/file-walker.ts";
import { detectLanguage, getExtensions } from "../src/index/files.ts";
import { applyIncrementalFileChanges } from "../src/index/incremental.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import { buildSemanticIndex } from "../src/index/vector-storage.ts";
import { vectorAt } from "../src/index/vectors.ts";
import type { Chunk } from "../src/types.ts";

const DIM = 384;
const REPS = 3;
const repo = process.cwd();

function median(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
}

async function time<T>(fn: () => Promise<T> | T): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

async function timed(fn: () => Promise<unknown> | unknown): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < REPS; i++) {
    runs.push(await time(fn));
  }
  return median(runs);
}

const files: string[] = [];
for await (const abs of walkFiles(repo, getExtensions(["code", "docs", "config"]))) {
  files.push(relative(repo, abs));
}
const sources = new Map<string, string>();
for (const f of files) {
  sources.set(f, await readFile(join(repo, f), "utf-8"));
}

// 1. chunking K files
const chunkOne = async (rel: string): Promise<Chunk[]> => {
  const source = await readFile(join(repo, rel), "utf-8");
  return chunkSource(source, rel, detectLanguage(rel));
};
const conc = resolveWorkerConcurrency();
console.log(`repo files: ${files.length}, worker concurrency: ${conc}\n`);
console.log("### Chunking K changed files (ms, median of 3)\n");
console.log("| K files | serial | mapPool | saved |");
console.log("|---:|---:|---:|---:|");
for (const k of [1, 10, 50, 200]) {
  const batch = Array.from({ length: k }, (_, i) => files[i % files.length] as string);
  const serial = await timed(async () => {
    for (const rel of batch) {
      await chunkOne(rel);
    }
  });
  const pooled = await timed(() => mapPool(batch, conc, chunkOne));
  console.log(
    `| ${k} | ${serial.toFixed(1)} | ${pooled.toFixed(1)} | ${(serial - pooled).toFixed(1)} ms (${(((serial - pooled) / serial) * 100).toFixed(0)}%) |`,
  );
}

// 2. fixed cost per update at N chunks
const realChunks: Chunk[] = [];
for (const [rel, source] of sources) {
  realChunks.push(...(await chunkSource(source, rel, detectLanguage(rel))));
}

function randomUnit(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let h = seed >>> 0;
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    v[i] = (h / 4294967296) * 2 - 1;
    norm += (v[i] ?? 0) ** 2;
  }
  return v.map((x) => x / Math.sqrt(norm));
}

const instant: EmbeddingBackend = {
  model: "mock",
  dimensions: DIM,
  async embedDocuments(texts) {
    return texts.map((_, i) => randomUnit(i));
  },
  async embedQuery() {
    return randomUnit(0);
  },
};

console.log(`\n### Fixed cost of one 1-file update at N chunks (ms, median of 3, dim ${DIM})\n`);
console.log(
  "| N chunks | keep vectors | BM25 rebuild | semantic rebuild | update, BM25 rebuilt | update, BM25 patched |",
);
console.log("|---:|---:|---:|---:|---:|---:|");
const editedRel = "src/miru-index.ts";
for (const n of [1_000, 5_000, 20_000, 50_000]) {
  const chunks: Chunk[] = Array.from({ length: n }, (_, i) => {
    const c = realChunks[i % realChunks.length] as Chunk;
    return i < realChunks.length
      ? c
      : { ...c, file_path: `${c.file_path}#${Math.floor(i / realChunks.length)}` };
  });
  const vectors = chunks.map((_, i) => randomUnit(i));
  const semanticIndex = buildSemanticIndex(vectors);

  const keep = await timed(() => {
    for (let i = 0; i < n; i++) {
      vectorAt(semanticIndex, i);
    }
  });
  const bm25Index = buildBm25FromChunks(chunks);
  const bm25 = await timed(() => buildBm25FromChunks(chunks));
  const semantic = await timed(() => buildSemanticIndex(vectors));

  const root = await mkdtemp(join(tmpdir(), "miru-timing-"));
  try {
    await mkdir(dirname(join(root, editedRel)), { recursive: true });
    await writeFile(join(root, editedRel), `${sources.get(editedRel)}\n// edited\n`, "utf-8");
    const update = (withBm25: boolean) =>
      timed(() =>
        applyIncrementalFileChanges({
          root,
          content: ["code", "docs", "config"],
          embeddings: instant,
          chunks,
          semanticIndex,
          ...(withBm25 ? { bm25: bm25Index } : {}),
          relativePaths: [editedRel],
        }),
      );
    const total = await update(false);
    const patched = await update(true);
    console.log(
      `| ${n} | ${keep.toFixed(0)} | ${bm25.toFixed(0)} | ${semantic.toFixed(0)} | ${total.toFixed(0)} | ${patched.toFixed(0)} |`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
