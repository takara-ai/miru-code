/**
 * Compare Miru `locate` (regex, files mode, file listing) against what Claude does today
 * with its Grep and Glob tools, on tokens (input + output) AND precision/recall.
 *
 *   regex-lines  Miru locate `/re/` mode=lines     vs  Grep output_mode=content (-n)
 *   regex-files  Miru locate `/re/` mode=files     vs  Grep output_mode=files_with_matches
 *   glob         Miru locate include=[glob]        vs  Glob pattern
 *
 * Claude's tools are modeled with ripgrep (the engine behind them), relative paths, no
 * truncation (the most favourable case for the baseline). Ground truth is an independent
 * brute-force scan (JS RegExp / Bun.Glob) over every tracked or untracked-not-ignored text file,
 * so neither tool defines "correct". Tokens use the repo's WordPiece counter: absolute numbers are
 * a proxy, ratios are what matter.
 *
 * Offline: chunks the repo directly, no embeddings or credentials needed.
 *
 *   bun run scripts/benchmark-regex-glob.ts [--verbose] [--json]
 */
import { formatLiteralLocate, listIndexedFiles, locateLiteral } from "../src/literal.ts";
import { formatLiteralLocateText } from "../src/mcp/format-text.ts";
import { countTokens } from "../src/token-count.ts";
import type { Chunk } from "../src/types.ts";
import {
  chunkRepoOffline,
  GLOB_QUERIES,
  REGEX_QUERIES,
  type RegexQuery,
  ROOT,
  repoPaths,
  score,
  type Task,
  trackedTextFiles,
  truthFiles,
  truthGlob,
  truthLines,
} from "./benchmark-regex-glob-lib.ts";

const verbose = process.argv.includes("--verbose");
const jsonOnly = process.argv.includes("--json");

const GREP = "Grep";
const GLOB = "Glob";
const MIRU_LOCATE = "mcp__plugin_miru_miru__locate";

function rg(args: string[]): string {
  const out = Bun.spawnSync(["rg", "--color", "never", "--hidden", "--glob", "!.git", ...args], {
    cwd: ROOT,
  });
  return new TextDecoder().decode(out.stdout).trimEnd();
}

type Run = { inTok: number; outTok: number; pred: Set<string> };

const callTokens = (tool: string, args: object): number =>
  countTokens(`${tool} ${JSON.stringify(args)}`);

function claudeGrepLines(q: RegexQuery): Run {
  const args = {
    pattern: q.pattern,
    output_mode: "content",
    "-n": true,
    ...(q.ignoreCase ? { "-i": true } : {}),
  };
  const text = rg(["-n", "--no-heading", ...(q.ignoreCase ? ["-i"] : []), "-e", q.pattern]);
  const pred = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^(.+?):(\d+):/.exec(line);
    if (m) {
      pred.add(`${m[1]}:${m[2]}`);
    }
  }
  return { inTok: callTokens(GREP, args), outTok: countTokens(text), pred };
}

function claudeGrepFiles(q: RegexQuery): Run {
  const args = { pattern: q.pattern, ...(q.ignoreCase ? { "-i": true } : {}) };
  const text = rg(["-l", ...(q.ignoreCase ? ["-i"] : []), "-e", q.pattern]);
  return {
    inTok: callTokens(GREP, args),
    outTok: countTokens(text),
    pred: new Set(text.split("\n").filter(Boolean)),
  };
}

function claudeGlob(pattern: string): Run {
  const text = rg(["--files", "-g", pattern]);
  return {
    inTok: callTokens(GLOB, { pattern }),
    outTok: countTokens(text),
    pred: new Set(text.split("\n").filter(Boolean)),
  };
}

const miruLiteral = (q: RegexQuery): string => `/${q.pattern}/${q.ignoreCase ? "i" : ""}`;

function miruRegex(chunks: Chunk[], q: RegexQuery, mode: "lines" | "files"): Run {
  const literal = miruLiteral(q);
  const result = locateLiteral(chunks, literal, { mode });
  const text = formatLiteralLocateText(formatLiteralLocate(result));
  const pred =
    mode === "files"
      ? new Set(result.file_list ?? [])
      : new Set(result.hits.map((h) => `${h.file_path}:${h.line}`));
  return { inTok: callTokens(MIRU_LOCATE, { literal, mode }), outTok: countTokens(text), pred };
}

function miruGlob(chunks: Chunk[], pattern: string): Run {
  const result = listIndexedFiles(chunks, { include: [pattern] });
  const text = formatLiteralLocateText(formatLiteralLocate(result));
  return {
    inTok: callTokens(MIRU_LOCATE, { include: [pattern] }),
    outTok: countTokens(text),
    pred: new Set(result.file_list ?? []),
  };
}

// ---------- truth + scoring ----------

// ---------- run ----------

type Row = {
  task: Task;
  query: string;
  tool: "claude" | "miru";
  inTok: number;
  outTok: number;
  total: number;
  pred: number;
  truth: number;
  tp: number;
  precision: number;
  recall: number;
  /** Recall over truth restricted to files Miru indexes (separates scope limits from real misses). */
  scopedRecall: number;
  f1: number;
};

console.error("Reading corpus and chunking offline...");
const allPaths = await repoPaths();
const files = await trackedTextFiles(allPaths);
const chunks = await chunkRepoOffline();
const indexed = new Set(chunks.map((c) => c.file_path));
console.error(
  `${files.size} text files in repo, ${indexed.size} indexed by Miru (${chunks.length} chunks)\n`,
);

const rows: Row[] = [];
function record(task: Task, query: string, tool: Row["tool"], run: Run, truth: Set<string>) {
  const s = score(run.pred, truth);
  const inIndex = new Set([...truth].filter((k) => indexed.has(k.replace(/:\d+$/, ""))));
  const scopedRecall = score(run.pred, inIndex).recall;
  rows.push({
    scopedRecall,
    task,
    query,
    tool,
    inTok: run.inTok,
    outTok: run.outTok,
    total: run.inTok + run.outTok,
    pred: run.pred.size,
    truth: truth.size,
    ...s,
  });
}

for (const q of REGEX_QUERIES) {
  const lines = truthLines(files, q);
  const filesTruth = truthFiles(files, q);
  record("regex-lines", q.id, "claude", claudeGrepLines(q), lines);
  record("regex-lines", q.id, "miru", miruRegex(chunks, q, "lines"), lines);
  record("regex-files", q.id, "claude", claudeGrepFiles(q), filesTruth);
  record("regex-files", q.id, "miru", miruRegex(chunks, q, "files"), filesTruth);
}
for (const pattern of GLOB_QUERIES) {
  const truth = truthGlob(allPaths, pattern);
  record("glob", pattern, "claude", claudeGlob(pattern), truth);
  record("glob", pattern, "miru", miruGlob(chunks, pattern), truth);
}

// ---------- report ----------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

type Summary = {
  task: Task;
  tool: string;
  in: number;
  out: number;
  total: number;
  medianTotal: number;
  sumTotal: number;
  precision: number;
  recall: number;
  /** Recall over truth restricted to files Miru indexes (separates scope limits from real misses). */
  scopedRecall: number;
  f1: number;
};
const summaries: Summary[] = [];
for (const task of ["regex-lines", "regex-files", "glob"] as Task[]) {
  for (const tool of ["claude", "miru"] as const) {
    const r = rows.filter((x) => x.task === task && x.tool === tool);
    summaries.push({
      task,
      tool,
      in: mean(r.map((x) => x.inTok)),
      out: mean(r.map((x) => x.outTok)),
      total: mean(r.map((x) => x.total)),
      medianTotal: median(r.map((x) => x.total)),
      sumTotal: r.reduce((a, x) => a + x.total, 0),
      precision: mean(r.map((x) => x.precision)),
      recall: mean(r.map((x) => x.recall)),
      scopedRecall: mean(r.map((x) => x.scopedRecall)),
      f1: mean(r.map((x) => x.f1)),
    });
  }
}

const verdicts = ["regex-lines", "regex-files", "glob"].map((task) => {
  const queries = [...new Set(rows.filter((r) => r.task === task).map((r) => r.query))];
  let fewerTokens = 0;
  let recallAtLeast = 0;
  let paretoWin = 0;
  for (const query of queries) {
    const c = rows.find((r) => r.task === task && r.query === query && r.tool === "claude");
    const m = rows.find((r) => r.task === task && r.query === query && r.tool === "miru");
    if (!c || !m) {
      continue;
    }
    const cheaper = m.total < c.total;
    const recallOk = m.recall >= c.recall - 1e-9;
    fewerTokens += cheaper ? 1 : 0;
    recallAtLeast += recallOk ? 1 : 0;
    paretoWin += cheaper && recallOk && m.precision >= c.precision - 1e-9 ? 1 : 0;
  }
  return { task, queries: queries.length, fewerTokens, recallAtLeast, paretoWin };
});

if (jsonOnly) {
  console.log(JSON.stringify({ summaries, verdicts, rows }, null, 2));
  process.exit(0);
}

if (verbose) {
  for (const task of ["regex-lines", "regex-files", "glob"] as Task[]) {
    console.log(`\n=== ${task} (per query) ===`);
    console.log(
      "query".padEnd(26),
      "tool".padEnd(7),
      "in".padStart(4),
      "out".padStart(6),
      "total".padStart(6),
      "pred".padStart(5),
      "truth".padStart(5),
      "prec".padStart(7),
      "recall".padStart(7),
    );
    for (const r of rows.filter((x) => x.task === task)) {
      console.log(
        r.query.slice(0, 25).padEnd(26),
        r.tool.padEnd(7),
        String(r.inTok).padStart(4),
        String(r.outTok).padStart(6),
        String(r.total).padStart(6),
        String(r.pred).padStart(5),
        String(r.truth).padStart(5),
        pct(r.precision).padStart(7),
        pct(r.recall).padStart(7),
      );
    }
  }
}

console.log("\n=== SUMMARY (mean per query) ===");
console.log(
  "task".padEnd(13),
  "tool".padEnd(7),
  "in tok".padStart(7),
  "out tok".padStart(8),
  "total".padStart(8),
  "median".padStart(8),
  "sum".padStart(8),
  "precision".padStart(10),
  "recall".padStart(8),
  "in-index".padStart(9),
  "F1".padStart(7),
);
for (const s of summaries) {
  console.log(
    s.task.padEnd(13),
    s.tool.padEnd(7),
    s.in.toFixed(1).padStart(7),
    s.out.toFixed(1).padStart(8),
    s.total.toFixed(1).padStart(8),
    s.medianTotal.toFixed(0).padStart(8),
    String(s.sumTotal).padStart(8),
    pct(s.precision).padStart(10),
    pct(s.recall).padStart(8),
    pct(s.scopedRecall).padStart(9),
    pct(s.f1).padStart(7),
  );
}
console.log("\n=== PER-QUERY WINS FOR MIRU ===");
for (const v of verdicts) {
  console.log(
    `${v.task.padEnd(13)} fewer total tokens: ${v.fewerTokens}/${v.queries}   recall >= claude: ${v.recallAtLeast}/${v.queries}   both + precision >= claude: ${v.paretoWin}/${v.queries}`,
  );
}
