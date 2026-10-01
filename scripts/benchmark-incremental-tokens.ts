/**
 * Embedding-token cost of an incremental update, before vs after chunk-level vector reuse.
 *
 * "before" is the pre-reuse implementation (pass `--before <path>` to a copy of it);
 * "after" is the current src/index/incremental.ts. Both run against real repo files with a
 * counting embedding backend, so the numbers are the tokens that would be sent to the API.
 *
 *   bun run scripts/benchmark-incremental-tokens.ts --before src/index/incremental.before.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chunkSource } from "../src/chunking/chunking.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { VectorIndex } from "../src/index/dense.ts";
import { detectLanguage } from "../src/index/files.ts";
import { applyIncrementalFileChanges as applyAfter } from "../src/index/incremental.ts";
import { countTokens } from "../src/token-count.ts";

const beforeFlag = process.argv.indexOf("--before");
const beforePath = beforeFlag >= 0 ? process.argv[beforeFlag + 1] : undefined;
if (!beforePath) {
  throw new Error("Usage: --before <path to the pre-reuse incremental.ts>");
}
const { applyIncrementalFileChanges: applyBefore } = (await import(resolve(beforePath))) as {
  applyIncrementalFileChanges: typeof applyAfter;
};

const DIM = 8;
const FILES = [
  "src/miru-index.ts",
  "src/mcp/index-cache.ts",
  "README.md",
  "package.json",
  ".github/workflows/ci.yml",
];

function backend(): EmbeddingBackend & { tokens: number; texts: number } {
  const b = {
    tokens: 0,
    texts: 0,
    model: "mock",
    dimensions: DIM,
    async embedDocuments(texts: string[]) {
      for (const t of texts) {
        b.tokens += countTokens(t);
        b.texts++;
      }
      return texts.map(() => new Float32Array(DIM).fill(1 / Math.sqrt(DIM)));
    },
    async embedQuery() {
      return new Float32Array(DIM).fill(1 / Math.sqrt(DIM));
    },
  };
  return b;
}

type Edit = { name: string; apply: (source: string) => string };

const EDITS: Edit[] = [
  {
    name: "touch (no change)",
    apply: (s) => s,
  },
  {
    name: "edit 1 line mid-file",
    apply: (s) => {
      const lines = s.split("\n");
      let i = Math.floor(lines.length / 2);
      while (i < lines.length && !lines[i]?.trim()) {
        i++;
      }
      lines[i] = `${lines[i]} edited`;
      return lines.join("\n");
    },
  },
  {
    name: "insert 3 lines at top",
    apply: (s) => `edited a\nedited b\nedited c\n${s}`,
  },
];

type Row = { file: string; edit: string; chunks: number; before: number; after: number };
const rows: Row[] = [];

for (const file of FILES) {
  const source = await readFile(file, "utf-8");
  for (const edit of EDITS) {
    const measured: number[] = [];
    let chunkCount = 0;
    for (const apply of [applyBefore, applyAfter]) {
      const root = await mkdtemp(join(tmpdir(), "miru-bench-"));
      try {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), source, "utf-8");
        const chunks = await chunkSource(source, file, detectLanguage(file));
        const b = backend();
        const vectors = await b.embedDocuments(chunks.map((c) => c.content));
        b.tokens = 0;
        await writeFile(join(root, file), edit.apply(source), "utf-8");
        const result = await apply({
          root,
          content: ["code", "docs", "config"],
          embeddings: b,
          chunks,
          semanticIndex: new VectorIndex(vectors),
          relativePaths: [file],
        });
        chunkCount = result.chunks.length;
        measured.push(b.tokens);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    rows.push({
      file,
      edit: edit.name,
      chunks: chunkCount,
      before: measured[0] ?? 0,
      after: measured[1] ?? 0,
    });
  }
}

const pct = (before: number, after: number): string =>
  before === 0 ? "-" : `${(((before - after) / before) * 100).toFixed(1)}%`;

console.log("| file | edit | chunks | tokens before | tokens after | saved |");
console.log("|---|---|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(
    `| ${r.file} | ${r.edit} | ${r.chunks} | ${r.before} | ${r.after} | ${pct(r.before, r.after)} |`,
  );
}
const totalBefore = rows.reduce((n, r) => n + r.before, 0);
const totalAfter = rows.reduce((n, r) => n + r.after, 0);
console.log(
  `| **total** | | | **${totalBefore}** | **${totalAfter}** | **${pct(totalBefore, totalAfter)}** |`,
);
