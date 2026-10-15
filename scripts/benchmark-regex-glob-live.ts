/**
 * Live comparison: real Claude Code Grep/Glob vs real Miru `locate`, driven through headless
 * `claude -p` sessions, so the model chooses the calls, the tools produce the real output, and
 * token counts come from the API's own usage numbers (Claude's tokenizer, not a proxy).
 *
 *   arm "claude": built-in tools Grep + Glob only
 *   arm "miru":   Miru MCP only (offline server, benchmark-mcp-offline-server.ts), tools named as
 *                 in the plugin (mcp__plugin_miru_miru__*) and loaded upfront via alwaysLoad
 *
 * Per run, "search tokens" = growth in prompt size from the first to the last request, i.e. every
 * tool call the model emitted plus every tool result it read. "call" is the model's own output
 * tokens for those calls; "result" is the rest. Fixed per-session cost (tool definitions and server
 * instructions) is the first request's size, compared across arms. Precision/recall are scored on
 * what the tools returned against an independent brute-force ground truth.
 *
 * Costs real money / plan usage (~$0.04 per run; the full set is ~80 sessions and can exhaust a
 * 5-hour session limit on a subscription plan - run it with headroom, or use --only/--limit).
 * It stops at the first rate-limit error rather than recording errors as results.
 * Refuses to start without --yes.
 * Raw streams are saved under <out-dir>/raw; --rescore re-reads them (free) after scoring changes.
 *
 *   bun run scripts/benchmark-regex-glob-live.ts --yes [--out-dir DIR] [--rescore] [--model ID]
 *       [--only regex-lines|regex-files|glob] [--limit N] [--concurrency N] [--verbose] [--json]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!flag("--yes") && !flag("--rescore")) {
  console.error(
    "This runs two real claude sessions per query (~80 for the full set) and spends API credits or plan usage (~$3, enough to hit a 5-hour session limit). Re-run with --yes.",
  );
  process.exit(1);
}

const OUT_DIR = opt("--out-dir") ?? join(process.env.TMPDIR ?? "/tmp", "miru-live-bench");
const MODEL = opt("--model") ?? "claude-sonnet-5-5";
const ONLY = opt("--only") as Task | undefined;
const LIMIT = Number(opt("--limit") ?? Number.POSITIVE_INFINITY);
const CONCURRENCY = Number(opt("--concurrency") ?? 4);
const RESCORE = flag("--rescore");
const MIRU_SERVER = "plugin_miru_miru";
const MIRU_PREFIX = `mcp__${MIRU_SERVER}__`;

type Arm = "claude" | "miru";
type Job = {
  task: Task;
  id: string;
  prompt: string;
  truth: Set<string>;
};

// ---------- jobs ----------

const allPaths = await repoPaths();
const pathSet = new Set(allPaths);
const files = await trackedTextFiles(allPaths);

const flagsNote = (q: RegexQuery): string => (q.ignoreCase ? " (case-insensitive)" : "");
const jobs: Job[] = [];
for (const q of REGEX_QUERIES) {
  jobs.push({
    task: "regex-lines",
    id: q.id,
    prompt: `List every line in this repository that matches the regular expression ${q.pattern}${flagsNote(q)}. Report file:line for each match. Reply with just the list.`,
    truth: truthLines(files, q),
  });
  jobs.push({
    task: "regex-files",
    id: q.id,
    prompt: `List the files in this repository that contain a line matching the regular expression ${q.pattern}${flagsNote(q)}. Reply with just the file paths.`,
    truth: truthFiles(files, q),
  });
}
for (const glob of GLOB_QUERIES) {
  jobs.push({
    task: "glob",
    id: glob,
    prompt: `List every file in this repository whose path matches the glob pattern ${glob}. Reply with just the file paths.`,
    truth: truthGlob(allPaths, glob),
  });
}
const selected = jobs.filter((j) => !ONLY || j.task === ONLY).slice(0, LIMIT);

// ---------- running claude ----------

await mkdir(join(OUT_DIR, "raw"), { recursive: true });
const mcpConfigPath = join(OUT_DIR, "miru-mcp.json");
await Bun.write(
  mcpConfigPath,
  JSON.stringify({
    mcpServers: {
      [MIRU_SERVER]: {
        type: "stdio",
        command: "bun",
        args: ["run", join(ROOT, "scripts", "benchmark-mcp-offline-server.ts")],
        alwaysLoad: true,
      },
    },
  }),
);

// The prompt must directly follow -p: --allowedTools/--tools are variadic and would swallow it.
const COMMON = [
  "--model",
  MODEL,
  "--disable-slash-commands",
  "--no-session-persistence",
  "--setting-sources",
  "project",
  "--max-budget-usd",
  "1",
  "--output-format",
  "stream-json",
  "--verbose",
];

function armArgs(arm: Arm): string[] {
  return arm === "claude"
    ? ["--tools", "Grep,Glob", "--strict-mcp-config"]
    : [
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfigPath,
        "--allowedTools",
        `mcp__${MIRU_SERVER}`,
      ];
}

type Block = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Turn = { id: string; totalIn: number; out: number; toolUses: Block[] };
type Parsed = {
  turns: Turn[];
  results: Map<string, { text: string; isError: boolean }>;
  toolNames: string[];
  finalText: string;
  cost: number;
  ok: boolean;
  /** The session/usage limit was hit: results from here on are errors, not measurements. */
  rateLimited: boolean;
};

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as Block).text) : ""))
      .join("\n");
  }
  return "";
}

function parseStream(raw: string): Parsed {
  const turns = new Map<string, Turn>();
  const results = new Map<string, { text: string; isError: boolean }>();
  let finalText = "";
  let cost = 0;
  let ok = false;
  let rateLimited = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const message = event.message as {
        id: string;
        usage: Record<string, number>;
        content: Block[];
      };
      const usage = message.usage;
      const totalIn =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const turn = turns.get(message.id) ?? { id: message.id, totalIn, out: 0, toolUses: [] };
      turn.totalIn = Math.max(turn.totalIn, totalIn);
      turn.out = Math.max(turn.out, usage.output_tokens ?? 0);
      for (const block of message.content) {
        if (block.type === "tool_use") {
          turn.toolUses.push(block);
        }
        if (block.type === "text") {
          finalText = block.text ?? finalText;
        }
      }
      turns.set(message.id, turn);
    } else if (event.type === "user") {
      const message = event.message as { content: Block[] | string };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            results.set(block.tool_use_id, {
              text: textOf(block.content),
              isError: block.is_error === true,
            });
          }
        }
      }
    } else if (event.type === "result") {
      cost = Number(event.total_cost_usd ?? 0);
      rateLimited = event.is_error === true && /limit/i.test(String(event.result ?? ""));
      ok = event.subtype === "success" && event.is_error !== true;
    }
  }
  const ordered = [...turns.values()];
  return {
    turns: ordered,
    results,
    toolNames: ordered.flatMap((t) => t.toolUses.map((u) => u.name ?? "?")),
    finalText,
    cost,
    ok,
    rateLimited,
  };
}

// ---------- reading what the tools returned ----------

const stripRoot = (p: string): string => (p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p);

/** Real Grep/Glob output: `path:line:text` lines, or one path per line (any header lines ignored). */
function predictFromClaude(task: Task, texts: string[]): Set<string> {
  const pred = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      const line = stripRoot(raw.trim());
      if (task === "regex-lines") {
        const m = /^(.+?):(\d+):/.exec(line);
        if (m && pathSet.has(m[1] ?? "")) {
          pred.add(`${m[1]}:${m[2]}`);
        }
      } else if (pathSet.has(line)) {
        pred.add(line);
      }
    }
  }
  return pred;
}

/**
 * Miru `locate` text, whichever mode the model chose: grouped `lines`, `path: 3, 9` locations,
 * directory-grouped or flat path lists. Returns both the file:line set and the file set.
 */
function parseMiru(texts: string[]): { lines: Set<string>; files: Set<string> } {
  const lines = new Set<string>();
  const files = new Set<string>();
  for (const text of texts) {
    let dir = "";
    let file = "";
    for (const raw of text.split("\n")) {
      if (!raw.trim()) {
        continue;
      }
      const indented = /^\s/.test(raw);
      const line = raw.trim();
      const hit = !indented ? /^(.+?):(\d+): /.exec(line) : null;
      const locs = !indented ? /^(.+?): ([\d, ]+)$/.exec(line) : null;
      if (hit && pathSet.has(hit[1] ?? "")) {
        files.add(hit[1] ?? "");
        lines.add(`${hit[1]}:${hit[2]}`);
      } else if (locs && pathSet.has(locs[1] ?? "")) {
        files.add(locs[1] ?? "");
        for (const n of (locs[2] ?? "").split(",")) {
          lines.add(`${locs[1]}:${n.trim()}`);
        }
      } else if (!indented && line.endsWith("/")) {
        dir = line === "./" ? "" : line;
      } else if (indented && file && /^\d+: /.test(line)) {
        files.add(file);
        lines.add(`${file}:${line.slice(0, line.indexOf(":"))}`);
      } else {
        const path = indented ? `${dir}${line}` : line;
        if (pathSet.has(path)) {
          files.add(path);
          if (!indented) {
            file = path;
          }
        }
        if (!indented) {
          dir = "";
        }
      }
    }
  }
  return { lines, files };
}

// ---------- one run ----------

/** Predicted sets by run, kept out of the serialized rows. */
const predSets = new Map<string, Set<string>>();
const runKey = (arm: Arm, task: Task, query: string): string => `${arm}|${task}|${query}`;

type RunRow = {
  arm: Arm;
  task: Task;
  query: string;
  ok: boolean;
  turns: number;
  tools: string[];
  firstIn: number;
  searchTok: number;
  callTok: number;
  resultTok: number;
  cost: number;
  rateLimited: boolean;
  pred: number;
  truth: number;
  precision: number;
  recall: number;
  scopedRecall: number;
  call: string;
};

async function runOne(arm: Arm, job: Job): Promise<RunRow> {
  const rawPath = join(
    OUT_DIR,
    "raw",
    `${arm}__${job.task}__${job.id.replace(/[^\w.-]+/g, "_")}.jsonl`,
  );
  let raw: string;
  if (RESCORE) {
    raw = await Bun.file(rawPath).text();
  } else {
    const proc = Bun.spawn(["claude", "-p", job.prompt, ...COMMON, ...armArgs(arm)], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    raw = await new Response(proc.stdout).text();
    await proc.exited;
    await Bun.write(rawPath, raw);
  }
  const parsed = parseStream(raw);

  const lastTurn = parsed.turns[parsed.turns.length - 1];
  const firstTurn = parsed.turns[0];
  const searchTurns = parsed.turns.filter((t) => t.toolUses.length > 0);
  const completed = parsed.ok && lastTurn !== undefined && lastTurn.toolUses.length === 0;
  const searchTok = completed && firstTurn && lastTurn ? lastTurn.totalIn - firstTurn.totalIn : 0;
  const callTok = searchTurns.reduce((a, t) => a + t.out, 0);

  const resultTexts = searchTurns
    .flatMap((t) => t.toolUses)
    .map((u) => parsed.results.get(u.id ?? ""))
    .filter((r): r is { text: string; isError: boolean } => r !== undefined && !r.isError)
    .map((r) => r.text);
  const miru = arm === "miru" ? parseMiru(resultTexts) : null;
  const pred =
    arm === "claude"
      ? predictFromClaude(job.task, resultTexts)
      : job.task === "regex-lines"
        ? (miru?.lines ?? new Set<string>())
        : (miru?.files ?? new Set<string>());
  const s = score(pred, job.truth);
  predSets.set(runKey(arm, job.task, job.id), pred);
  const call = searchTurns
    .flatMap((t) => t.toolUses)
    .map((u) => `${(u.name ?? "").replace(MIRU_PREFIX, "miru:")} ${JSON.stringify(u.input)}`)
    .join(" ; ");

  return {
    arm,
    task: job.task,
    query: job.id,
    ok: completed,
    turns: parsed.turns.length,
    tools: parsed.toolNames,
    firstIn: firstTurn?.totalIn ?? 0,
    searchTok,
    callTok,
    resultTok: Math.max(0, searchTok - callTok),
    cost: parsed.cost,
    rateLimited: parsed.rateLimited,
    pred: pred.size,
    truth: job.truth.size,
    precision: s.precision,
    recall: s.recall,
    scopedRecall: s.recall, // recomputed against the indexed subset after all runs
    call,
  };
}

// ---------- orchestrate ----------

const queue: Array<{ arm: Arm; job: Job }> = selected.flatMap((job) =>
  (["claude", "miru"] as const).map((arm) => ({ arm, job })),
);
const rows: RunRow[] = [];
let done = 0;
async function worker(): Promise<void> {
  for (;;) {
    const next = queue.shift();
    if (!next) {
      return;
    }
    const row = await runOne(next.arm, next.job);
    if (row.rateLimited) {
      queue.length = 0;
      console.error("Usage limit hit: stopping. Rows from this run on are not measurements.");
      continue;
    }
    rows.push(row);
    done += 1;
    console.error(
      `[${done}/${selected.length * 2}] ${next.arm.padEnd(6)} ${next.job.task.padEnd(11)} ${next.job.id.slice(0, 24).padEnd(24)} ${row.ok ? "ok " : "FAIL"} search=${row.searchTok} tools=${row.tools.length}`,
    );
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// in-index recall: truth restricted to files Miru indexes (from the offline chunker)
const indexed = new Set((await chunkRepoOffline()).map((c) => c.file_path));
for (const row of rows) {
  const job = selected.find((j) => j.task === row.task && j.id === row.query);
  if (!job) {
    continue;
  }
  const inIndex = new Set([...job.truth].filter((k) => indexed.has(k.replace(/:\d+$/, ""))));
  row.scopedRecall = score(
    predSets.get(runKey(row.arm, row.task, row.query)) ?? new Set(),
    inIndex,
  ).recall;
}

// ---------- report ----------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

await Bun.write(join(OUT_DIR, "live-results.json"), JSON.stringify(rows, null, 2));

if (flag("--json")) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const tasks = ["regex-lines", "regex-files", "glob"] as Task[];
if (flag("--verbose")) {
  for (const task of tasks) {
    console.log(`\n=== ${task} ===`);
    for (const row of rows
      .filter((r) => r.task === task)
      .sort((a, b) => a.query.localeCompare(b.query) || a.arm.localeCompare(b.arm))) {
      console.log(
        `${row.query.slice(0, 22).padEnd(23)} ${row.arm.padEnd(6)} ${row.ok ? "" : "FAIL "}search=${String(row.searchTok).padStart(6)} (call ${String(row.callTok).padStart(3)} + result ${String(row.resultTok).padStart(6)}) turns=${row.turns} P=${pct(row.precision)} R=${pct(row.recall)}  ${row.call.slice(0, 90)}`,
      );
    }
  }
}

console.log("\n=== SUMMARY: real tokens (API usage), mean per query ===");
console.log(
  "task".padEnd(12),
  "arm".padEnd(7),
  "n".padStart(3),
  "call".padStart(6),
  "result".padStart(8),
  "search".padStart(8),
  "median".padStart(8),
  "turns".padStart(6),
  "prec".padStart(7),
  "recall".padStart(8),
  "in-idx".padStart(8),
  "$/run".padStart(7),
);
for (const task of tasks) {
  for (const arm of ["claude", "miru"] as const) {
    const r = rows.filter((x) => x.task === task && x.arm === arm && x.ok);
    if (r.length === 0) {
      continue;
    }
    console.log(
      task.padEnd(12),
      arm.padEnd(7),
      String(r.length).padStart(3),
      mean(r.map((x) => x.callTok))
        .toFixed(0)
        .padStart(6),
      mean(r.map((x) => x.resultTok))
        .toFixed(0)
        .padStart(8),
      mean(r.map((x) => x.searchTok))
        .toFixed(0)
        .padStart(8),
      median(r.map((x) => x.searchTok))
        .toFixed(0)
        .padStart(8),
      mean(r.map((x) => x.turns))
        .toFixed(1)
        .padStart(6),
      pct(mean(r.map((x) => x.precision))).padStart(7),
      pct(mean(r.map((x) => x.recall))).padStart(8),
      pct(mean(r.map((x) => x.scopedRecall))).padStart(8),
      mean(r.map((x) => x.cost))
        .toFixed(3)
        .padStart(7),
    );
  }
}

console.log("\n=== PER-QUERY: Miru vs Claude (same query, both runs completed) ===");
for (const task of tasks) {
  const queries = [...new Set(rows.filter((r) => r.task === task).map((r) => r.query))];
  let cheaper = 0;
  let recallOk = 0;
  let both = 0;
  let n = 0;
  for (const q of queries) {
    const c = rows.find((r) => r.task === task && r.query === q && r.arm === "claude" && r.ok);
    const m = rows.find((r) => r.task === task && r.query === q && r.arm === "miru" && r.ok);
    if (!c || !m) {
      continue;
    }
    n += 1;
    const cheap = m.searchTok < c.searchTok;
    const rec = m.recall >= c.recall - 1e-9;
    cheaper += cheap ? 1 : 0;
    recallOk += rec ? 1 : 0;
    both += cheap && rec && m.precision >= c.precision - 1e-9 ? 1 : 0;
  }
  console.log(
    `${task.padEnd(12)} fewer search tokens: ${cheaper}/${n}   recall >= claude: ${recallOk}/${n}   both + precision >= claude: ${both}/${n}`,
  );
}

console.log("\n=== FIXED PER-SESSION COST (first request size, includes tool definitions) ===");
for (const arm of ["claude", "miru"] as const) {
  const r = rows.filter((x) => x.arm === arm && x.firstIn > 0);
  console.log(
    `${arm.padEnd(7)} median first-request tokens: ${median(r.map((x) => x.firstIn)).toFixed(0)}`,
  );
}
const failed = rows.filter((r) => !r.ok);
const toolSearchCalls = rows.filter((r) => r.tools.includes("ToolSearch")).length;
console.log(
  `\nruns: ${rows.length}, failed/incomplete: ${failed.length}, runs that used ToolSearch: ${toolSearchCalls}, total cost: $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}`,
);
console.log(`raw rows: ${join(OUT_DIR, "live-results.json")}`);
