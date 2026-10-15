/**
 * PR-review context benchmark: how many tokens does it take to gather the context a reviewer
 * needs, and how much of that context does each strategy actually deliver?
 *
 * No LLM, no network. Every non-merge commit is a "PR" (parent..commit). Tokens use the repo's
 * WordPiece counter, so absolute numbers are a proxy and ratios are what matter.
 *
 *   baseline-lean     git diff + Grep -n per changed symbol
 *   baseline-typical  git diff + Read each changed file in full + Grep per symbol + Read top caller files
 *   miru-refs         noise-filtered diff + one `locate` for all changed symbols (diff-visible lines removed)
 *   miru-refs-ctx     miru-refs + the enclosing chunk of every hunk
 *   miru-u0-ctx       -U0 diff + enclosing chunks + refs (chunks supply the context, not diff padding)
 *
 * Quality is two recall numbers against brute-force truth (neither tool defines "correct"):
 *   refs  head lines mentioning a symbol declared/removed in the diff, not already shown by the diff
 *   ctx   the rest of every chunk that contains a changed line
 *
 * Add a strategy by appending to STRATEGIES; rerun to compare. Diff files are cached per commit.
 *
 *   bun run scripts/benchmark-pr-review.ts [--commits 12] [--rev HEAD] [--verbose] [--json]
 */
import { formatLiteralLocate, locateLiteral } from "../src/literal.ts";
import { formatLiteralLocateText } from "../src/mcp/format-text.ts";
import { countTokens } from "../src/token-count.ts";
import {
  changedSymbols,
  chunksAt,
  commitSubject,
  ctxTruth,
  type FileDiff,
  gitOut,
  isNoise,
  lineKey,
  listCommits,
  parseDiff,
  rawDiff,
  refTruth,
  type Snapshot,
  score,
  shownKeys,
  snapshot,
  symbolRegex,
  useRepo,
} from "./benchmark-pr-review-lib.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const verbose = argv.includes("--verbose");
const jsonOnly = argv.includes("--json");
const COMMITS = Number(flag("--commits") ?? 12);
const REV = flag("--rev") ?? "HEAD";
const REPO = flag("--repo");
const PRS = argv.includes("--prs");
/** Skip sprawling PRs: reviewers split those, and one outlier dominates totals. */
const MAX_PR_FILES = 40;

/** How many caller files baseline-typical opens in full after Grep (an assumption, not a measurement). */
const TYPICAL_CALLER_READS = 3;

type Ctx = {
  sha: string;
  snap: Snapshot;
  diff3: FileDiff[];
  diff0: FileDiff[];
  raw3: string;
  raw0: string;
  symbols: string[];
};
type Out = { text: string; seen: Set<string> };

const call = (tool: string, args: object): string => `${tool} ${JSON.stringify(args)}\n`;
const reviewable = (f: FileDiff): boolean => !isNoise(f.path) && !f.binary;

function addShown(seen: Set<string>, files: FileDiff[]): void {
  for (const k of shownKeys(files)) {
    seen.add(k);
  }
}

// ---------- Claude Code baselines ----------

function grepSymbols(c: Ctx): { text: string; hits: Map<string, number> } {
  let text = "";
  const hits = new Map<string, number>();
  for (const sym of c.symbols) {
    const re = new RegExp(symbolRegex(sym));
    let out = "";
    for (const [path, lines] of [...c.snap.files].sort(([a], [b]) => a.localeCompare(b))) {
      lines.forEach((l, i) => {
        if (re.test(l)) {
          out += `${path}:${i + 1}:${l}\n`;
          hits.set(path, (hits.get(path) ?? 0) + 1);
        }
      });
    }
    text += call("Grep", { pattern: symbolRegex(sym), output_mode: "content", "-n": true }) + out;
  }
  return { text, hits };
}

function seenFromGrep(c: Ctx, seen: Set<string>): void {
  for (const sym of c.symbols) {
    const re = new RegExp(symbolRegex(sym));
    for (const [path, lines] of c.snap.files) {
      lines.forEach((l, i) => {
        if (re.test(l)) {
          seen.add(lineKey(path, i + 1));
        }
      });
    }
  }
}

function baselineLean(c: Ctx): Out {
  const seen = new Set<string>();
  addShown(seen, c.diff3);
  seenFromGrep(c, seen);
  return {
    text: call("Bash", { command: "git diff main...HEAD" }) + c.raw3 + grepSymbols(c).text,
    seen,
  };
}

function readFull(c: Ctx, path: string, seen: Set<string>): string {
  const lines = c.snap.files.get(path);
  if (!lines) {
    return "";
  }
  lines.forEach((_, i) => {
    seen.add(lineKey(path, i + 1));
  });
  return (
    call("Read", { file_path: path }) + lines.map((l, i) => `${i + 1}\t${l}`).join("\n") + "\n"
  );
}

function baselineTypical(c: Ctx): Out {
  const seen = new Set<string>();
  addShown(seen, c.diff3);
  let text = call("Bash", { command: "git diff main...HEAD" }) + c.raw3;
  const read = new Set<string>();
  for (const f of c.diff3) {
    if (f.deleted || f.binary || !c.snap.files.has(f.path) || isNoise(f.path)) {
      continue;
    }
    read.add(f.path);
    text += readFull(c, f.path, seen);
  }
  const grep = grepSymbols(c);
  text += grep.text;
  seenFromGrep(c, seen);
  const callers = [...grep.hits].filter(([p]) => !read.has(p)).sort((a, b) => b[1] - a[1]);
  for (const [path] of callers.slice(0, TYPICAL_CALLER_READS)) {
    text += readFull(c, path, seen);
  }
  return { text, seen };
}

// ---------- Miru strategies ----------

function filteredDiff(files: FileDiff[]): string {
  return files
    .map((f) => (reviewable(f) ? f.text : `${f.path} (+${f.added} -${f.removed}, omitted)\n`))
    .join("");
}

function enclosingChunks(c: Ctx, seen: Set<string>): string {
  let text = "";
  for (const f of c.diff3) {
    if (!reviewable(f) || f.deleted) {
      continue;
    }
    for (const ch of chunksAt(c.snap, f.path, f.changed)) {
      text += `${ch.file_path}:${ch.start_line}-${ch.end_line}\n${ch.content}\n`;
      for (let n = ch.start_line; n <= ch.end_line; n++) {
        seen.add(lineKey(ch.file_path, n));
      }
    }
  }
  return text;
}

function miruRefs(c: Ctx, seen: Set<string>): string {
  if (c.symbols.length === 0) {
    return "";
  }
  const literals = c.symbols.map((s) => `/${symbolRegex(s)}/`);
  const result = locateLiteral(c.snap.chunks, literals, { mode: "lines" });
  const hits = result.hits.filter((h) => !seen.has(lineKey(h.file_path, h.line)));
  for (const h of hits) {
    seen.add(lineKey(h.file_path, h.line));
  }
  const text = formatLiteralLocateText(
    formatLiteralLocate({
      ...result,
      hits,
      n: hits.length,
      files: new Set(hits.map((h) => h.file_path)).size,
    }),
  );
  return call("mcp__plugin_miru_miru__locate", { literal: literals, mode: "lines" }) + text;
}

function miruRefsOnly(c: Ctx): Out {
  const seen = new Set<string>();
  addShown(seen, c.diff3);
  const text = call("review_context", {}) + filteredDiff(c.diff3);
  return { text: text + miruRefs(c, seen), seen };
}

function miruRefsCtx(c: Ctx): Out {
  const seen = new Set<string>();
  addShown(seen, c.diff3);
  let text = call("review_context", {}) + filteredDiff(c.diff3);
  text += enclosingChunks(c, seen);
  return { text: text + miruRefs(c, seen), seen };
}

function miruU0Ctx(c: Ctx): Out {
  const seen = new Set<string>();
  addShown(seen, c.diff0);
  let text = call("review_context", {}) + filteredDiff(c.diff0);
  text += enclosingChunks(c, seen);
  // Truth excludes U3-visible lines; keep those out of the refs list too only if actually shown.
  return { text: text + miruRefs(c, seen), seen };
}

const STRATEGIES: Array<{ name: string; run: (c: Ctx) => Out }> = [
  { name: "baseline-lean", run: baselineLean },
  { name: "baseline-typical", run: baselineTypical },
  { name: "miru-refs", run: miruRefsOnly },
  { name: "miru-refs-ctx", run: miruRefsCtx },
  { name: "miru-u0-ctx", run: miruU0Ctx },
];

// ---------- run ----------

type Row = {
  sha: string;
  subject: string;
  files: number;
  symbols: number;
  refTruth: number;
  ctxTruth: number;
  strategy: string;
  tokens: number;
  refRecall: number;
  ctxRecall: number;
};

/** One review unit: a commit (parent..commit) or an open PR (merge-base..PR head). */
type Unit = { id: string; base: string; head: string; subject: string };

function localUnits(): Unit[] {
  return listCommits(COMMITS, REV).map((sha) => ({
    id: sha.slice(0, 7),
    base: `${sha}^`,
    head: sha,
    subject: commitSubject(sha),
  }));
}

/** Open, non-draft, human-authored PRs of a clone's `origin`, fetched as refs/pr/N. */
function prUnits(): Unit[] {
  const list = Bun.spawnSync(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,isDraft,author,changedFiles,title",
    ],
    { cwd: REPO },
  );
  const prs = (
    JSON.parse(new TextDecoder().decode(list.stdout)) as Array<{
      number: number;
      isDraft: boolean;
      author: { is_bot: boolean };
      changedFiles: number;
      title: string;
    }>
  ).filter(
    (p) => !p.isDraft && !p.author.is_bot && p.changedFiles > 0 && p.changedFiles <= MAX_PR_FILES,
  );
  const units: Unit[] = [];
  for (const pr of prs) {
    if (units.length >= COMMITS) {
      break;
    }
    const fetched = Bun.spawnSync(
      ["git", "fetch", "-q", "origin", `+pull/${pr.number}/head:refs/pr/${pr.number}`],
      { cwd: REPO },
    );
    if (fetched.exitCode !== 0) {
      continue;
    }
    const head = gitOut(["rev-parse", `refs/pr/${pr.number}`]).trim();
    const base = gitOut(["merge-base", "origin/HEAD", head]).trim();
    if (head && base) {
      units.push({ id: `#${pr.number}`, base, head, subject: pr.title });
    }
  }
  return units;
}

const rows: Row[] = [];
if (REPO) {
  useRepo(REPO);
}
const units = PRS ? prUnits() : localUnits();
console.error(
  `Benchmarking ${units.length} ${PRS ? "open PRs" : "commits"} in ${REPO ?? "miru-code"}...`,
);

for (const unit of units) {
  const sha = unit.head;
  const raw3 = rawDiff(unit.base, unit.head, 3);
  const raw0 = rawDiff(unit.base, unit.head, 0);
  const diff3 = parseDiff(raw3);
  const diff0 = parseDiff(raw0);
  const symbols = changedSymbols(diff3);
  const snap = await snapshot(sha);
  const shown = shownKeys(diff3);
  const refs = refTruth(snap, symbols, shown);
  const ctx = ctxTruth(snap, diff3, shown);
  const c: Ctx = { sha, snap, diff3, diff0, raw3, raw0, symbols };
  for (const s of STRATEGIES) {
    const out = s.run(c);
    rows.push({
      sha: unit.id,
      subject: unit.subject.slice(0, 48),
      files: diff3.length,
      symbols: symbols.length,
      refTruth: refs.size,
      ctxTruth: ctx.size,
      strategy: s.name,
      tokens: countTokens(out.text),
      refRecall: score(out.seen, refs),
      ctxRecall: score(out.seen, ctx),
    });
  }
  console.error(`  ${unit.id} done`);
}

// ---------- report ----------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pad = (s: string | number, n: number): string => String(s).padEnd(n);

const summary = STRATEGIES.map((s) => {
  const mine = rows.filter((r) => r.strategy === s.name);
  return {
    strategy: s.name,
    tokens: mine.reduce((a, r) => a + r.tokens, 0),
    medianTokens:
      [...mine.map((r) => r.tokens)].sort((a, b) => a - b)[Math.floor(mine.length / 2)] ?? 0,
    refRecall: mean(mine.map((r) => r.refRecall)),
    ctxRecall: mean(mine.map((r) => r.ctxRecall)),
    /** Median over units of 1 - tokens / baseline-typical tokens on the same unit. */
    medianSaving: median(
      mine.map((r) => {
        const typical =
          rows.find((t) => t.sha === r.sha && t.strategy === "baseline-typical")?.tokens ?? 0;
        return typical === 0 ? 0 : 1 - r.tokens / typical;
      }),
    ),
  };
});
const base = summary.find((s) => s.strategy === "baseline-typical")?.tokens ?? 1;

if (jsonOnly) {
  console.log(
    JSON.stringify(
      { repo: REPO ?? "miru-code", units: units.length, summary, rows: verbose ? rows : undefined },
      null,
      2,
    ),
  );
} else {
  if (verbose) {
    for (const r of rows) {
      console.log(
        `${r.sha} ${pad(r.strategy, 17)} ${pad(r.tokens, 7)} refs ${pad(pct(r.refRecall), 7)} ctx ${pad(pct(r.ctxRecall), 7)} (${r.files}f ${r.symbols}s ${r.refTruth}r ${r.ctxTruth}c) ${r.subject}`,
      );
    }
    console.log();
  }
  console.log(
    `${pad("strategy", 18)}${pad("tokens", 9)}${pad("median", 8)}${pad("vs typical", 12)}${pad("median save", 13)}${pad("refs recall", 13)}ctx recall`,
  );
  for (const s of summary) {
    console.log(
      `${pad(s.strategy, 18)}${pad(s.tokens, 9)}${pad(s.medianTokens, 8)}${pad(pct(s.tokens / base), 12)}${pad(pct(s.medianSaving), 13)}${pad(pct(s.refRecall), 13)}${pct(s.ctxRecall)}`,
    );
  }
}
