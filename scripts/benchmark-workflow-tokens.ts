/**
 * Workflow token comparison: Miru search+expand vs grep+Read.
 *
 * Models what agents actually need for useful context:
 * - Miru: snippet search (top_k) + expand on rank-1 hit (MCP expand defaults)
 * - Grep: keyword rg output (top_k files) + Read on rank-1 grep file
 * - Recovery: read candidates in rank order until a labelled relevant file is reached.
 *
 * Usage:
 *   bun run benchmark:workflow
 *   bun run benchmark:workflow -- --repos gin,flask
 *   bun run benchmark:workflow -- --json
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GrepFileHit, grepSearch } from "../src/benchmark/grep.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { formatExpandResultsText, formatResultsText } from "../src/mcp/format-text.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { applySnippetsToResults } from "../src/snippet.ts";
import { countTokens } from "../src/token-count.ts";
import type { Chunk, SearchResult } from "../src/types.ts";
import {
  DEFAULT_EXPAND_AFTER,
  DEFAULT_EXPAND_BEFORE,
  dedupeResultsByFile,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
} from "../src/utils.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

process.env.MIRU_SEARCH_V2 = "1";

function parseArgs(): { repos: Set<string> | null; json: boolean } {
  const argv = process.argv.slice(2);
  let repos: Set<string> | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repos" && argv[i + 1]) {
      repos = new Set(
        argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { repos, json };
}

function expandLineSpan(chunks: { start_line: number; end_line: number }[]): number {
  if (chunks.length === 0) {
    return 0;
  }
  const start = Math.min(...chunks.map((c) => c.start_line));
  const end = Math.max(...chunks.map((c) => c.end_line));
  return end - start + 1;
}

function miruExpandTokens(
  index: MiruIndex,
  repoPath: string,
  top: SearchResult | undefined,
  query: string,
): { tokens: number; lineSpan: number; file: string | null } {
  if (!top) {
    return { tokens: 0, lineSpan: 0, file: null };
  }
  const [{ meta }] = applySnippetsToResults([top], query);
  const line = meta.truncated ? meta.anchor_line : top.chunk.start_line;
  const { anchor, chunks } = expandChunksAtLine(
    index.chunks,
    top.chunk.file_path,
    line,
    repoPath,
    DEFAULT_EXPAND_BEFORE,
    DEFAULT_EXPAND_AFTER,
  );
  if (!anchor) {
    return { tokens: 0, lineSpan: 0, file: null };
  }
  return {
    tokens: countTokens(
      formatExpandResultsText(
        formatExpandResults(top.chunk.file_path, line, anchor, chunks, {
          repoRoot: repoPath,
          before: DEFAULT_EXPAND_BEFORE,
          after: DEFAULT_EXPAND_AFTER,
        }),
      ),
    ),
    lineSpan: expandLineSpan(chunks),
    file: top.chunk.file_path,
  };
}

function firstGrepMatchLine(hit: GrepFileHit | undefined): number | null {
  if (!hit?.output) {
    return null;
  }
  for (const line of hit.output.split("\n")) {
    if (!line.trim() || line === "--") {
      continue;
    }
    // path/to/file:123:content
    const withPath = line.match(/:(\d+)[:-]/);
    if (withPath?.[1]) {
      return Number(withPath[1]);
    }
    // 123:content or 123-content (rg single-file output)
    const bare = line.match(/^(\d+)[:-]/);
    if (bare?.[1]) {
      return Number(bare[1]);
    }
  }
  return null;
}

async function readFileTokens(absPath: string): Promise<number> {
  try {
    const text = await readFile(absPath, "utf-8");
    return countTokens(text);
  } catch {
    return 0;
  }
}

async function readLineWindowTokens(
  absPath: string,
  centerLine: number,
  lineSpan: number,
): Promise<number> {
  try {
    const text = await readFile(absPath, "utf-8");
    const lines = text.split("\n");
    if (lines.length === 0) {
      return 0;
    }
    const half = Math.max(1, Math.floor(lineSpan / 2));
    const start = Math.max(1, centerLine - half);
    const end = Math.min(lines.length, centerLine + half);
    return countTokens(lines.slice(start - 1, end).join("\n"));
  } catch {
    return 0;
  }
}

function grepExpandEquivTokens(
  index: MiruIndex,
  repoPath: string,
  file: string | null,
  line: number | null,
): number {
  if (!file || line == null) {
    return 0;
  }
  const { chunks } = expandChunksAtLine(
    index.chunks,
    file,
    line,
    repoPath,
    DEFAULT_EXPAND_BEFORE,
    DEFAULT_EXPAND_AFTER,
  );
  return countTokens(
    formatExpandResultsText(
      formatExpandResults(file, line, undefined, chunks, {
        repoRoot: repoPath,
        before: DEFAULT_EXPAND_BEFORE,
        after: DEFAULT_EXPAND_AFTER,
      }),
    ),
  );
}

async function loadSnippetSources(
  repoPath: string,
  results: SearchResult[],
): Promise<Map<string, Chunk>> {
  const sources = new Map<string, Chunk>();
  await Promise.all(
    [...new Set(results.map((result) => result.chunk.file_path))].map(async (filePath) => {
      try {
        const content = await readFile(join(repoPath, filePath), "utf-8");
        const indexed = results.find((result) => result.chunk.file_path === filePath)?.chunk;
        if (indexed && content.includes(indexed.content)) {
          sources.set(filePath, {
            content,
            file_path: filePath,
            start_line: 1,
            end_line: content.split("\n").length,
            language: indexed.language,
          });
        }
      } catch {
        // Preserve the indexed hit when a source file is unavailable.
      }
    }),
  );
  return sources;
}

interface WorkflowRow {
  repo: string;
  category: string;
  query: string;
  miruSearch: number;
  miruExpand: number;
  miruWorkflow: number;
  grepSearch: number;
  grepReadFull: number;
  grepReadMatched: number;
  grepWorkflowFull: number;
  grepWorkflowMatched: number;
  grepExpandEquiv: number;
  miruRecovery: number;
  grepRecoveryFull: number;
  grepRecoveryMatched: number;
  grepRecoveryExpandEquiv: number;
  miruRelevantRank: number | null;
  grepRelevantRank: number | null;
  miruTop: string | null;
  grepTop: string | null;
  miruRecall: boolean;
  grepRecall: boolean;
  miruPrecisionAtK: number;
  grepPrecisionAtK: number;
  miruTop1: boolean;
  grepTop1: boolean;
}

async function evaluateWorkflow(
  repo: string,
  repoPath: string,
  index: MiruIndex,
  spec: (typeof REPO_BENCHES)[number]["queries"][number],
): Promise<WorkflowRow> {
  const results = dedupeResultsByFile(
    await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
  ).slice(0, TOP_K);
  const miruSearch = countTokens(
    formatResultsText(
      formatResults(spec.query, results, {
        repoRoot: repoPath,
        snippet: true,
        snippetSourceChunks: await loadSnippetSources(repoPath, results),
      }),
    ),
  );
  const topMiru = results[0];
  const expand = miruExpandTokens(index, repoPath, topMiru, spec.query);
  const miruWorkflow = miruSearch + expand.tokens;

  const grep = await grepSearch(repoPath, spec.query, TOP_K);
  const grepSearchTokens = grep.tokens;
  const topGrepHit = grep.hits[0];
  const grepTop = topGrepHit?.file ?? null;
  const grepAbsPath = grepTop ? join(repoPath, grepTop) : null;
  const grepMatchLine = firstGrepMatchLine(topGrepHit);

  const grepReadFull = grepAbsPath ? await readFileTokens(grepAbsPath) : 0;
  const matchedSpan = expand.lineSpan > 0 ? expand.lineSpan : 60;
  const grepReadMatched =
    grepAbsPath && grepMatchLine != null
      ? await readLineWindowTokens(grepAbsPath, grepMatchLine, matchedSpan)
      : 0;
  const grepExpandEquiv = grepExpandEquivTokens(index, repoPath, grepTop, grepMatchLine);

  const miruFiles = results.map((r) => r.chunk.file_path);
  const miruRecall = spec.relevant.some((want) => miruFiles.some((f) => pathMatches(f, want)));
  const grepRecall = spec.relevant.some((want) => grep.files.some((f) => pathMatches(f, want)));
  const miruRelevantCount = miruFiles.filter((file) =>
    spec.relevant.some((want) => pathMatches(file, want)),
  ).length;
  const grepRelevantCount = grep.files.filter((file) =>
    spec.relevant.some((want) => pathMatches(file, want)),
  ).length;
  const miruRelevantIndex = results.findIndex((result) =>
    spec.relevant.some((want) => pathMatches(result.chunk.file_path, want)),
  );
  const grepRelevantIndex = grep.hits.findIndex((hit) =>
    spec.relevant.some((want) => pathMatches(hit.file, want)),
  );
  const miruCandidateCount = miruRelevantIndex >= 0 ? miruRelevantIndex + 1 : results.length;
  const grepCandidateCount = grepRelevantIndex >= 0 ? grepRelevantIndex + 1 : grep.hits.length;

  let miruRecoveryExpand = 0;
  for (const result of results.slice(0, miruCandidateCount)) {
    miruRecoveryExpand += miruExpandTokens(index, repoPath, result, spec.query).tokens;
  }

  let grepRecoveryFullRead = 0;
  let grepRecoveryMatchedRead = 0;
  let grepRecoveryEquivRead = 0;
  for (const hit of grep.hits.slice(0, grepCandidateCount)) {
    const hitPath = join(repoPath, hit.file);
    const hitLine = firstGrepMatchLine(hit);
    grepRecoveryFullRead += await readFileTokens(hitPath);
    if (hitLine != null) {
      grepRecoveryMatchedRead += await readLineWindowTokens(hitPath, hitLine, matchedSpan);
    }
    grepRecoveryEquivRead += grepExpandEquivTokens(index, repoPath, hit.file, hitLine);
  }

  return {
    repo,
    category: spec.category,
    query: spec.query,
    miruSearch,
    miruExpand: expand.tokens,
    miruWorkflow,
    grepSearch: grepSearchTokens,
    grepReadFull,
    grepReadMatched,
    grepWorkflowFull: grepSearchTokens + grepReadFull,
    grepWorkflowMatched: grepSearchTokens + grepReadMatched,
    grepExpandEquiv: grepSearchTokens + grepExpandEquiv,
    miruRecovery: miruSearch + miruRecoveryExpand,
    grepRecoveryFull: grepSearchTokens + grepRecoveryFullRead,
    grepRecoveryMatched: grepSearchTokens + grepRecoveryMatchedRead,
    grepRecoveryExpandEquiv: grepSearchTokens + grepRecoveryEquivRead,
    miruRelevantRank: miruRelevantIndex >= 0 ? miruRelevantIndex + 1 : null,
    grepRelevantRank: grepRelevantIndex >= 0 ? grepRelevantIndex + 1 : null,
    miruTop: topMiru?.chunk.file_path ?? null,
    grepTop,
    miruRecall,
    grepRecall,
    miruPrecisionAtK: miruRelevantCount / Math.max(1, miruFiles.length),
    grepPrecisionAtK: grepRelevantCount / Math.max(1, grep.files.length),
    miruTop1: miruRelevantIndex === 0,
    grepTop1: grepRelevantIndex === 0,
  };
}

function mean(rows: WorkflowRow[], pick: (r: WorkflowRow) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0) / (rows.length || 1);
}

function printTable(rows: WorkflowRow[]): void {
  console.log("");
  console.log(
    "repo".padEnd(12) +
      "cat".padEnd(14) +
      "M:sch+exp".padEnd(10) +
      "G:sch+full".padEnd(12) +
      "G:sch+win".padEnd(12) +
      "G:sch+xp".padEnd(12) +
      "query",
  );
  console.log("-".repeat(100));
  for (const row of rows) {
    const q = row.query.length > 36 ? `${row.query.slice(0, 33)}...` : row.query;
    console.log(
      row.repo.padEnd(12) +
        row.category.padEnd(14) +
        String(row.miruWorkflow).padEnd(10) +
        String(row.grepWorkflowFull).padEnd(12) +
        String(row.grepWorkflowMatched).padEnd(12) +
        String(row.grepExpandEquiv).padEnd(12) +
        q,
    );
  }
}

const { repos: repoFilter, json } = parseArgs();
const benches = REPO_BENCHES.filter((b) => !repoFilter || repoFilter.has(b.name));
const available = [];
for (const bench of benches) {
  if (await pathExists(bench.path)) {
    available.push(bench);
  }
}

if (available.length === 0) {
  console.error("No benchmark repos found.");
  process.exit(1);
}

console.error(
  `Workflow tokens — Miru search+expand vs grep+Read (${available.length} repos, top_k=${TOP_K}, expand ±${DEFAULT_EXPAND_BEFORE}/${DEFAULT_EXPAND_AFTER} chunks)\n`,
);

const rows: WorkflowRow[] = [];
for (const bench of available) {
  console.error(`Indexing ${bench.name}...`);
  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  for (const spec of bench.queries) {
    rows.push(await evaluateWorkflow(bench.name, bench.path, index, spec));
  }
}

const summary = {
  queryCount: rows.length,
  topK: TOP_K,
  expandBefore: DEFAULT_EXPAND_BEFORE,
  expandAfter: DEFAULT_EXPAND_AFTER,
  recall: {
    miru: rows.filter((r) => r.miruRecall).length / rows.length,
    grep: rows.filter((r) => r.grepRecall).length / rows.length,
  },
  accuracy: {
    miruTop1: mean(rows, (r) => Number(r.miruTop1)),
    grepTop1: mean(rows, (r) => Number(r.grepTop1)),
    miruPrecisionAtK: mean(rows, (r) => r.miruPrecisionAtK),
    grepPrecisionAtK: mean(rows, (r) => r.grepPrecisionAtK),
  },
  meanTokens: {
    miruSearchOnly: mean(rows, (r) => r.miruSearch),
    miruExpandOnly: mean(rows, (r) => r.miruExpand),
    miruWorkflow: mean(rows, (r) => r.miruWorkflow),
    grepSearchOnly: mean(rows, (r) => r.grepSearch),
    grepReadFull: mean(rows, (r) => r.grepReadFull),
    grepReadMatched: mean(rows, (r) => r.grepReadMatched),
    grepWorkflowFull: mean(rows, (r) => r.grepWorkflowFull),
    grepWorkflowMatched: mean(rows, (r) => r.grepWorkflowMatched),
    grepExpandEquiv: mean(rows, (r) => r.grepExpandEquiv),
    miruRecovery: mean(rows, (r) => r.miruRecovery),
    grepRecoveryFull: mean(rows, (r) => r.grepRecoveryFull),
    grepRecoveryMatched: mean(rows, (r) => r.grepRecoveryMatched),
    grepRecoveryExpandEquiv: mean(rows, (r) => r.grepRecoveryExpandEquiv),
  },
  rows,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printTable(rows);
  const m = summary.meanTokens;
  console.log("");
  console.log("=== WORKFLOW TOKEN SUMMARY (per query avg) ===");
  console.log("");
  console.log("Search-only (initial tool output):");
  console.log(`  miru snippets     ${m.miruSearchOnly.toFixed(0)}`);
  console.log(`  grep rg matches   ${m.grepSearchOnly.toFixed(0)}`);
  console.log("");
  console.log("Follow-up (to get useful context):");
  console.log(
    `  miru expand       ${m.miruExpandOnly.toFixed(0)}  (rank-1 hit, ±${DEFAULT_EXPAND_BEFORE} chunk)`,
  );
  console.log(`  grep Read full    ${m.grepReadFull.toFixed(0)}  (entire rank-1 grep file)`);
  console.log(
    `  grep Read window  ${m.grepReadMatched.toFixed(0)}  (±same line span as miru expand)`,
  );
  console.log("");
  console.log("Full workflows:");
  console.log(`  miru search+expand           ${m.miruWorkflow.toFixed(0)}`);
  console.log(`  grep search+Read(full file)  ${m.grepWorkflowFull.toFixed(0)}`);
  console.log(`  grep search+Read(window)     ${m.grepWorkflowMatched.toFixed(0)}`);
  console.log(
    `  grep search+chunk-equiv      ${m.grepExpandEquiv.toFixed(0)}  (indexed chunks on grep rank-1)`,
  );
  console.log("");
  console.log("Label-aware recovery within top-k (reads until a labelled relevant file):");
  console.log(`  miru search+expands          ${m.miruRecovery.toFixed(0)}`);
  console.log(`  grep search+Reads(full)      ${m.grepRecoveryFull.toFixed(0)}`);
  console.log(`  grep search+Reads(window)    ${m.grepRecoveryMatched.toFixed(0)}`);
  console.log(`  grep search+chunk-equiv      ${m.grepRecoveryExpandEquiv.toFixed(0)}`);
  console.log("");
  console.log(
    `Recall@${TOP_K}: miru ${(summary.recall.miru * 100).toFixed(0)}%  |  grep ${(summary.recall.grep * 100).toFixed(0)}%`,
  );
  console.log(
    `miru workflow vs grep+Read(full): ${((1 - m.miruWorkflow / m.grepWorkflowFull) * 100).toFixed(0)}% fewer tokens`,
  );
  console.log(
    `miru workflow vs grep+Read(window): ${m.miruWorkflow < m.grepWorkflowMatched ? "" : "+"}${(m.miruWorkflow - m.grepWorkflowMatched).toFixed(0)} tokens (${m.miruWorkflow < m.grepWorkflowMatched ? "miru smaller" : "grep smaller"})`,
  );
}
