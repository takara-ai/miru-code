/**
 * Workflow token comparison: Miru search+expand vs grep+Read.
 *
 * Models what agents actually need for useful context:
 * - Miru: snippet search (top_k) + expand on rank-1 hit (before=1, after=1)
 * - Grep: keyword rg output (top_k files) + Read on rank-1 grep file
 *
 * Usage:
 *   bun run benchmark:workflow
 *   bun run benchmark:workflow -- --repos gin,flask
 *   bun run benchmark:workflow -- --json
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { applySnippetsToResults, estimateResultTokens } from "../src/snippet.ts";
import type { SearchResult } from "../src/types.ts";
import { dedupeResultsByFile, expandChunksAtLine } from "../src/utils.ts";
import { type GrepFileHit, grepSearch } from "./benchmark-grep.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

process.env.MIRU_SEARCH_V2 = "1";

const EXPAND_BEFORE = 1;
const EXPAND_AFTER = 1;

function estTokens(text: string): number {
  return Math.floor(text.length / 4);
}

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
  const { chunks } = expandChunksAtLine(
    index.chunks,
    top.chunk.file_path,
    line,
    repoPath,
    EXPAND_BEFORE,
    EXPAND_AFTER,
  );
  return {
    tokens: chunks.reduce((sum, chunk) => sum + estTokens(chunk.content), 0),
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
    return estTokens(text);
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
    return estTokens(lines.slice(start - 1, end).join("\n"));
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
    EXPAND_BEFORE,
    EXPAND_AFTER,
  );
  return chunks.reduce((sum, chunk) => sum + estTokens(chunk.content), 0);
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
  miruTop: string | null;
  grepTop: string | null;
  miruRecall: boolean;
  grepRecall: boolean;
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
  const snippetResults = applySnippetsToResults(results, spec.query).map((e) => e.result);
  const miruSearch = estimateResultTokens(snippetResults);
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
    miruTop: topMiru?.chunk.file_path ?? null,
    grepTop,
    miruRecall,
    grepRecall,
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
  `Workflow tokens — Miru search+expand vs grep+Read (${available.length} repos, top_k=${TOP_K}, expand ±${EXPAND_BEFORE}/${EXPAND_AFTER} chunks)\n`,
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
  expandBefore: EXPAND_BEFORE,
  expandAfter: EXPAND_AFTER,
  recall: {
    miru: rows.filter((r) => r.miruRecall).length / rows.length,
    grep: rows.filter((r) => r.grepRecall).length / rows.length,
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
    `  miru expand       ${m.miruExpandOnly.toFixed(0)}  (rank-1 hit, ±${EXPAND_BEFORE} chunk)`,
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
