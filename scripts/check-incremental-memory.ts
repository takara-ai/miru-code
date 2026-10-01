/**
 * Leak check for incremental updates: apply many edits to a copy of this repo, replacing the
 * index each time (as MiruIndex does), and report heap and index size after a forced GC.
 * Each edit swaps a trailing marker line for one with a token that never appears again, so live
 * content stays constant and any growth in chunks or vocabulary means stale data is being kept.
 *
 *   bun run scripts/check-incremental-memory.ts [iterations]
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chunkSource } from "../src/chunking/chunking.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { walkFiles } from "../src/index/file-walker.ts";
import { detectLanguage, getExtensions } from "../src/index/files.ts";
import { applyIncrementalFileChanges } from "../src/index/incremental.ts";
import { buildBm25FromChunks } from "../src/index/sparse.ts";
import { buildSemanticIndex } from "../src/index/vector-storage.ts";
import { seededRandom } from "../tests/test-helpers.ts";

const iterations = Number(process.argv[2] ?? 300);
const SAMPLE_EVERY = 50;
const DIM = 384;
const content = ["code", "docs", "config"] as const;

const MARKER = /\n\/\/ uniquetoken\w+\n$/;
const rand = seededRandom(42);
const embeddings: EmbeddingBackend = {
  model: "mock",
  dimensions: DIM,
  async embedDocuments(texts) {
    return texts.map(() => Float32Array.from({ length: DIM }, () => rand() * 2 - 1));
  },
  async embedQuery() {
    return new Float32Array(DIM);
  },
};

const root = await mkdtemp(join(tmpdir(), "miru-leak-"));
try {
  await cp("src", join(root, "src"), { recursive: true });
  await cp("tests", join(root, "tests"), { recursive: true });
  await cp("README.md", join(root, "README.md"));

  const files: string[] = [];
  for await (const abs of walkFiles(root, getExtensions([...content]))) {
    files.push(relative(root, abs));
  }
  let chunks = (
    await Promise.all(
      files.map(async (rel) =>
        chunkSource(await Bun.file(join(root, rel)).text(), rel, detectLanguage(rel)),
      ),
    )
  ).flat();
  let bm25 = buildBm25FromChunks(chunks);
  let semanticIndex = buildSemanticIndex(
    await embeddings.embedDocuments(chunks.map((c) => c.content)),
  );

  const sample = (iteration: number): void => {
    Bun.gc(true);
    const { heapUsed, rss } = process.memoryUsage();
    const vocabulary = Object.keys(bm25.toJSON().postings).length;
    console.log(
      `| ${iteration} | ${chunks.length} | ${bm25.size} | ${vocabulary} | ${(heapUsed / 1e6).toFixed(1)} | ${(rss / 1e6).toFixed(0)} |`,
    );
  };

  console.log(`files: ${files.length}, iterations: ${iterations}\n`);
  console.log("| iteration | chunks | bm25 docs | vocabulary | heap MB | rss MB |");
  console.log("|---:|---:|---:|---:|---:|---:|");
  sample(0);

  for (let i = 1; i <= iterations; i++) {
    const edited = [0, 1, 2].map((k) => files[(i * 7 + k * 31) % files.length] as string);
    for (const rel of new Set(edited)) {
      const path = join(root, rel);
      const text = (await Bun.file(path).text()).replace(MARKER, "");
      await Bun.write(path, `${text}\n// uniquetoken${i}x${rel.length}\n`);
    }
    const result = await applyIncrementalFileChanges({
      root,
      content: [...content],
      embeddings,
      chunks,
      semanticIndex,
      bm25,
      relativePaths: [...new Set(edited)],
    });
    ({ chunks, bm25, semantic: semanticIndex } = { ...result, semantic: result.semantic });
    if (i % SAMPLE_EVERY === 0) {
      sample(i);
    }
  }

  // After all that churn the patched index must equal one built from scratch: no stale terms.
  const fresh = buildBm25FromChunks(chunks).toJSON();
  const same = Bun.deepEquals(bm25.toJSON(), fresh);
  console.log(`\npatched BM25 equals fresh rebuild: ${same}`);
  process.exitCode = same ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
