import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSource } from "../src/chunking/chunking.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import type { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { detectLanguage } from "../src/index/files.ts";
import { applyIncrementalFileChanges } from "../src/index/incremental.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import { vectorAt } from "../src/index/vectors.ts";
import type { Chunk } from "../src/types.ts";

const DIM = 8;

/** Deterministic embedding: a pure function of the text, like the real backend. */
function vectorFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = Number(BigInt.asUintN(32, BigInt(Bun.hash(text))));
  for (let i = 0; i < DIM; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    v[i] = (h / 4294967296) * 2 - 1;
  }
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** The default index is int8-quantized, so stored vectors match only approximately. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

function countingBackend(): EmbeddingBackend & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    embedded,
    model: "mock",
    dimensions: DIM,
    async embedDocuments(texts: string[]) {
      embedded.push(...texts);
      return texts.map(vectorFor);
    },
    async embedQuery() {
      return vectorFor("query");
    },
  };
}

const rep = (n: number, line: (j: number) => string): string =>
  Array.from({ length: n }, (_, j) => line(j)).join("\n");

type Sample = {
  ext: string;
  /** One top-level definition; `v` is the value we mutate to edit it. */
  block: (i: number, v: number) => string;
  header?: string;
  /** Whether the chunker is expected to split this sample into several chunks. */
  splits?: boolean;
};

const LINES = 40;

const SAMPLES: Record<string, Sample> = {
  typescript: {
    ext: ".ts",
    splits: true,
    block: (i, v) =>
      `export function f${i}(x: number): number {\n${rep(LINES, (j) => `  const a${j} = x * ${j};`)}\n  return x + ${v};\n}\n`,
  },
  tsx: {
    ext: ".tsx",
    splits: true,
    block: (i, v) =>
      `export function C${i}(): number {\n${rep(LINES, (j) => `  const a${j} = ${j};`)}\n  return ${v};\n}\n`,
  },
  javascript: {
    ext: ".js",
    splits: true,
    block: (i, v) =>
      `export function f${i}(x) {\n${rep(LINES, (j) => `  const a${j} = x * ${j};`)}\n  return x + ${v};\n}\n`,
  },
  python: {
    ext: ".py",
    splits: true,
    block: (i, v) =>
      `def f${i}(x):\n${rep(LINES, (j) => `    a${j} = x * ${j}`)}\n    return x + ${v}\n\n`,
  },
  go: {
    ext: ".go",
    splits: true,
    header: "package main\n\n",
    block: (i, v) =>
      `func f${i}(x int) int {\n${rep(LINES, (j) => `\t_ = x * ${j}`)}\n\treturn x + ${v}\n}\n\n`,
  },
  rust: {
    ext: ".rs",
    splits: true,
    block: (i, v) =>
      `fn f${i}(x: i32) -> i32 {\n${rep(LINES, (j) => `    let a${j} = x * ${j};`)}\n    x + ${v}\n}\n\n`,
  },
  java: {
    ext: ".java",
    splits: true,
    block: (i, v) =>
      `class C${i} {\n  int f(int x) {\n${rep(LINES, (j) => `    int a${j} = x * ${j};`)}\n    return x + ${v};\n  }\n}\n\n`,
  },
  kotlin: {
    ext: ".kt",
    splits: true,
    block: (i, v) =>
      `fun f${i}(x: Int): Int {\n${rep(LINES, (j) => `    val a${j} = x * ${j}`)}\n    return x + ${v}\n}\n\n`,
  },
  c: {
    ext: ".c",
    splits: true,
    block: (i, v) =>
      `int f${i}(int x) {\n${rep(LINES, (j) => `  int a${j} = x * ${j};`)}\n  return x + ${v};\n}\n\n`,
  },
  cpp: {
    ext: ".cpp",
    splits: true,
    block: (i, v) =>
      `int f${i}(int x) {\n${rep(LINES, (j) => `  int a${j} = x * ${j};`)}\n  return x + ${v};\n}\n\n`,
  },
  csharp: {
    ext: ".cs",
    splits: true,
    block: (i, v) =>
      `class C${i} {\n  int F(int x) {\n${rep(LINES, (j) => `    int a${j} = x * ${j};`)}\n    return x + ${v};\n  }\n}\n\n`,
  },
  ruby: {
    ext: ".rb",
    splits: true,
    block: (i, v) =>
      `def f${i}(x)\n${rep(LINES, (j) => `  a${j} = x * ${j}`)}\n  x + ${v}\nend\n\n`,
  },
  php: {
    ext: ".php",
    splits: true,
    header: "<?php\n",
    block: (i, v) =>
      `function f${i}($x) {\n${rep(LINES, (j) => `  $a${j} = $x * ${j};`)}\n  return $x + ${v};\n}\n\n`,
  },
  swift: {
    ext: ".swift",
    splits: true,
    block: (i, v) =>
      `func f${i}(_ x: Int) -> Int {\n${rep(LINES, (j) => `    let a${j} = x * ${j}`)}\n    return x + ${v}\n}\n\n`,
  },
  scala: {
    ext: ".scala",
    splits: true,
    block: (i, v) =>
      `object O${i} {\n  def f(x: Int): Int = {\n${rep(LINES, (j) => `    val a${j} = x * ${j}`)}\n    x + ${v}\n  }\n}\n\n`,
  },
  elixir: {
    ext: ".ex",
    splits: true,
    block: (i, v) =>
      `defmodule M${i} do\n  def f(x) do\n${rep(LINES, (j) => `    a${j} = x * ${j}`)}\n    x + ${v}\n  end\nend\n\n`,
  },
  haskell: {
    ext: ".hs",
    splits: true,
    block: (i, v) =>
      `f${i} :: Int -> Int\nf${i} x = x + ${v}\n${rep(LINES, (j) => `  where a${j} = x * ${j}`)}\n\n`,
  },
  bash: {
    ext: ".sh",
    splits: true,
    block: (i, v) =>
      `f${i}() {\n${rep(LINES, (j) => `  a${j}=$((x * ${j}))`)}\n  echo $((x + ${v}))\n}\n\n`,
  },
  lua: {
    ext: ".lua",
    splits: true,
    block: (i, v) =>
      `function f${i}(x)\n${rep(LINES, (j) => `  local a${j} = x * ${j}`)}\n  return x + ${v}\nend\n\n`,
  },
  dart: {
    ext: ".dart",
    splits: true,
    block: (i, v) =>
      `int f${i}(int x) {\n${rep(LINES, (j) => `  var a${j} = x * ${j};`)}\n  return x + ${v};\n}\n\n`,
  },
  sql: {
    ext: ".sql",
    splits: true,
    block: (i, v) =>
      `${rep(LINES, (j) => `SELECT a${j} FROM t${i} WHERE x = ${j};`)}\nSELECT ${v} FROM t${i};\n\n`,
  },
  markdown: {
    ext: ".md",
    splits: true,
    block: (i, v) =>
      `## Section ${i}\n\n${rep(LINES, (j) => `Paragraph line ${j} about topic ${i}.`)}\n\nValue ${v}.\n\n`,
  },
  json: {
    ext: ".json",
    block: (i, v) => `{"k${i}": {${rep(LINES, (j) => `"a${j}": ${j}`)}, "v": ${v}}}\n`,
  },
  yaml: {
    ext: ".yaml",
    block: (i, v) => `k${i}:\n${rep(LINES, (j) => `  a${j}: ${j}`)}\n  v: ${v}\n`,
  },
  toml: {
    ext: ".toml",
    block: (i, v) => `[k${i}]\n${rep(LINES, (j) => `a${j} = ${j}`)}\nv = ${v}\n\n`,
  },
  css: {
    ext: ".css",
    splits: true,
    block: (i, v) =>
      `.c${i} {\n${rep(LINES, (j) => `  margin-left: ${j}px;`)}\n  top: ${v}px;\n}\n\n`,
  },
  html: {
    ext: ".html",
    block: (i, v) =>
      `<div id="d${i}">\n${rep(LINES, (j) => `  <p>line ${j}</p>`)}\n  <b>${v}</b>\n</div>\n`,
  },
  vue: {
    ext: ".vue",
    block: (i, v) =>
      `<script>\nexport function f${i}(x) {\n${rep(LINES, (j) => `  const a${j} = x * ${j};`)}\n  return x + ${v};\n}\n</script>\n`,
  },
  svelte: {
    ext: ".svelte",
    block: (i, v) =>
      `<script>\n  export function f${i}(x) {\n${rep(LINES, (j) => `    const a${j} = x * ${j};`)}\n    return x + ${v};\n  }\n</script>\n`,
  },
  erb: {
    ext: ".erb",
    block: (i, v) => `<div>\n${rep(LINES, (j) => `  <%= x${i}_${j} %>`)}\n  <%= ${v} %>\n</div>\n`,
  },
  ejs: {
    ext: ".ejs",
    block: (i, v) => `<div>\n${rep(LINES, (j) => `  <%= x${i}_${j} %>`)}\n  <%= ${v} %>\n</div>\n`,
  },
};

const BLOCKS = 6;
const EDITED = 3;

function build(sample: Sample, values: number[]): string {
  return (sample.header ?? "") + values.map((v, i) => sample.block(i, v)).join("");
}

async function indexFile(root: string, rel: string, source: string, backend: EmbeddingBackend) {
  await writeFile(join(root, rel), source, "utf-8");
  const chunks = await chunkSource(source, rel, detectLanguage(join(root, rel)));
  const vectors = await backend.embedDocuments(chunks.map((c) => c.content));
  return {
    chunks,
    semanticIndex: new VectorIndex(vectors),
    bm25: buildBm25FromChunks(chunks),
  };
}

async function applyEdit(
  root: string,
  rel: string,
  state: { chunks: Chunk[]; semanticIndex: VectorIndex; bm25: BM25Index },
  backend: EmbeddingBackend,
  newSource: string,
) {
  await writeFile(join(root, rel), newSource, "utf-8");
  return applyIncrementalFileChanges({
    root,
    content: ["code", "docs", "config"],
    embeddings: backend,
    chunks: state.chunks,
    semanticIndex: state.semanticIndex,
    bm25: state.bm25,
    relativePaths: [rel],
  });
}

/** The index must equal a from-scratch index of the file: no stale chunks or vectors. */
async function expectMatchesFreshIndex(
  root: string,
  rel: string,
  newSource: string,
  result: { chunks: Chunk[]; semantic: Parameters<typeof vectorAt>[0]; bm25: BM25Index },
) {
  const fresh = await chunkSource(newSource, rel, detectLanguage(join(root, rel)));
  expect(result.chunks).toEqual(fresh);
  expect(result.bm25.toJSON()).toEqual(buildBm25FromChunks(fresh).toJSON());
  result.chunks.forEach((chunk, i) => {
    expect(cosine(vectorAt(result.semantic, i), vectorFor(chunk.content))).toBeGreaterThan(0.999);
  });
}

describe("incremental re-embedding reuses unchanged chunks", () => {
  for (const [language, sample] of Object.entries(SAMPLES)) {
    describe(language, () => {
      const rel = `sample${sample.ext}`;
      const base = Array.from({ length: BLOCKS }, (_, i) => i);

      test("editing one definition embeds only the chunks whose text changed", async () => {
        const root = await mkdtemp(join(tmpdir(), "miru-reuse-"));
        try {
          const backend = countingBackend();
          const state = await indexFile(root, rel, build(sample, base), backend);
          backend.embedded.length = 0;

          const edited = base.map((v, i) => (i === EDITED ? 999 : v));
          const newSource = build(sample, edited);
          const result = await applyEdit(root, rel, state, backend, newSource);

          const oldTexts = new Set(state.chunks.map((c) => c.content));
          const expected = [
            ...new Set(result.chunks.map((c) => c.content).filter((t) => !oldTexts.has(t))),
          ];
          expect([...backend.embedded].sort()).toEqual([...expected].sort());
          if (sample.splits) {
            expect(state.chunks.length).toBeGreaterThanOrEqual(3);
            expect(backend.embedded.length).toBeLessThan(result.chunks.length);
          }
          await expectMatchesFreshIndex(root, rel, newSource, result);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      test("inserting a definition at the top shifts lines but stays correct", async () => {
        const root = await mkdtemp(join(tmpdir(), "miru-reuse-"));
        try {
          const backend = countingBackend();
          const state = await indexFile(root, rel, build(sample, base), backend);
          backend.embedded.length = 0;

          const newSource = build(sample, [777, ...base]);
          const result = await applyEdit(root, rel, state, backend, newSource);

          const oldTexts = new Set(state.chunks.map((c) => c.content));
          for (const text of backend.embedded) {
            expect(oldTexts.has(text)).toBe(false);
          }
          await expectMatchesFreshIndex(root, rel, newSource, result);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      test("touching a file without changing it embeds nothing", async () => {
        const root = await mkdtemp(join(tmpdir(), "miru-reuse-"));
        try {
          const backend = countingBackend();
          const source = build(sample, base);
          const state = await indexFile(root, rel, source, backend);
          backend.embedded.length = 0;

          const result = await applyEdit(root, rel, state, backend, source);

          expect(backend.embedded).toEqual([]);
          await expectMatchesFreshIndex(root, rel, source, result);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  }

  test("identical chunks within a file are embedded once", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-reuse-"));
    try {
      const sample = SAMPLES.typescript as Sample;
      const rel = "dup.ts";
      const backend = countingBackend();
      const state = await indexFile(root, rel, sample.block(0, 1), backend);
      backend.embedded.length = 0;

      const newSource = `${sample.block(1, 5)}${sample.block(1, 5)}${sample.block(1, 5)}`;
      const result = await applyEdit(root, rel, state, backend, newSource);

      expect(new Set(backend.embedded).size).toBe(backend.embedded.length);
      await expectMatchesFreshIndex(root, rel, newSource, result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
