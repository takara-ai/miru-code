/**
 * Shared git snapshot, diff parsing and ground truth for the PR-review benchmark
 * (benchmark-pr-review.ts). No LLM and no network: every commit in the repo's history is
 * treated as a "PR" (parent..commit), and the head tree is read straight from git objects.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSource } from "../src/chunking/chunking.ts";
import { ensureParserInit } from "../src/chunking/grammars.ts";
import { detectLanguage, getExtensions } from "../src/index/files.ts";
import { type Chunk, defaultContentTypes } from "../src/types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MAX_FILE_BYTES = 2_000_000;
const decoder = new TextDecoder();

/** Repo every git call runs in; defaults to Miru itself, `--repo` points it elsewhere. */
let repoDir = ROOT;
export function useRepo(dir: string): void {
  repoDir = resolve(dir);
  blobCache.clear();
  chunkCache.clear();
}

function git(args: string[], input?: Uint8Array): Buffer {
  const out = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdin: input });
  return Buffer.from(out.stdout);
}

export const gitOut = (args: string[]): string => git(args).toString("utf8");

const gitText = (args: string[]): string => git(args).toString("utf8");

// ---------- commits ----------

export function listCommits(count: number, rev: string): string[] {
  const shas = gitText(["rev-list", "--no-merges", "--max-parents=1", `-n`, `${count * 3}`, rev])
    .split("\n")
    .filter(Boolean);
  const out: string[] = [];
  for (const sha of shas) {
    const hasParent = gitText(["rev-list", "--parents", "-n", "1", sha]).trim().includes(" ");
    if (hasParent) {
      out.push(sha);
    }
    if (out.length === count) {
      break;
    }
  }
  return out;
}

export const commitSubject = (sha: string): string =>
  gitText(["log", "-1", "--format=%s", sha]).trim();

export const rawDiff = (base: string, head: string, unified: number): string =>
  gitText(["diff", `-U${unified}`, base, head]);

// ---------- head snapshot ----------

export type Snapshot = {
  /** Indexed-extension text files at the commit, as lines. */
  files: Map<string, string[]>;
  chunks: Chunk[];
};

const indexedExts = getExtensions(defaultContentTypes());
const isIndexedPath = (p: string): boolean => indexedExts.some((e) => p.endsWith(e));

const blobCache = new Map<string, string | null>();
const chunkCache = new Map<string, Chunk[]>();

function readBlobs(shas: string[]): void {
  const missing = [...new Set(shas.filter((s) => !blobCache.has(s)))];
  if (missing.length === 0) {
    return;
  }
  const buf = git(["cat-file", "--batch"], new TextEncoder().encode(`${missing.join("\n")}\n`));
  let pos = 0;
  for (const sha of missing) {
    const eol = buf.indexOf(10, pos);
    const [, , size] = buf.subarray(pos, eol).toString("utf8").split(" ");
    const len = Number(size);
    const body = buf.subarray(eol + 1, eol + 1 + len);
    pos = eol + 1 + len + 1;
    blobCache.set(sha, len > MAX_FILE_BYTES || body.includes(0) ? null : decoder.decode(body));
  }
}

export async function snapshot(sha: string): Promise<Snapshot> {
  await ensureParserInit();
  const entries = gitText(["ls-tree", "-r", "-z", sha])
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf("\t");
      return { blob: row.slice(0, tab).split(" ")[2] ?? "", path: row.slice(tab + 1) };
    })
    .filter((e) => isIndexedPath(e.path));
  readBlobs(entries.map((e) => e.blob));

  const files = new Map<string, string[]>();
  const chunks: Chunk[] = [];
  for (const { blob, path } of entries) {
    const text = blobCache.get(blob);
    if (text == null || text.length === 0) {
      continue;
    }
    files.set(path, text.split("\n"));
    const key = `${blob}:${path}`;
    let fileChunks = chunkCache.get(key);
    if (!fileChunks) {
      fileChunks = await chunkSource(text, path, detectLanguage(path));
      chunkCache.set(key, fileChunks);
    }
    chunks.push(...fileChunks);
  }
  return { files, chunks };
}

// ---------- diff ----------

export type FileDiff = {
  path: string;
  /** Verbatim section of the unified diff, header included. */
  text: string;
  added: number;
  removed: number;
  deleted: boolean;
  binary: boolean;
  /** New-side line numbers shown in the diff (hunk bodies, context included). */
  shown: Set<number>;
  /** New-side line numbers of added lines. */
  changed: Set<number>;
  /** Added and removed line texts (no +/- prefix), for symbol extraction. */
  touched: string[];
};

export function parseDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) {
      continue;
    }
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    const path = header?.[2] ?? "";
    const file: FileDiff = {
      path,
      text: section,
      added: 0,
      removed: 0,
      deleted: /^deleted file mode/m.test(section),
      binary: /^Binary files /m.test(section) || /^GIT binary patch/m.test(section),
      shown: new Set(),
      changed: new Set(),
      touched: [],
    };
    let newLine = 0;
    let inHunk = false;
    for (const line of section.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        continue;
      }
      if (line.startsWith("+")) {
        file.added++;
        file.changed.add(newLine);
        file.shown.add(newLine++);
        file.touched.push(line.slice(1));
      } else if (line.startsWith("-")) {
        file.removed++;
        file.touched.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        file.shown.add(newLine++);
      }
    }
    out.push(file);
  }
  return out;
}

/** Lockfiles, snapshots, minified/generated output: nobody reviews these line by line. */
const NOISE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.(snap|min\.js|min\.css|map|svg|wasm|png|jpg|ico)$|(^|\/)(dist|coverage|reports|node_modules)\/|\.generated\.|coverage-badge\.json$/;
export const isNoise = (path: string): boolean => NOISE.test(path);

// ---------- symbols + truth ----------

const DECL =
  /\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|mod)\s+([A-Za-z_]\w{3,})/g;
const STOP = new Set(
  "this that true false null undefined void string number boolean async await from default return export import const type function class test describe expect".split(
    " ",
  ),
);

/** Only API-surface declarations: `export ...` or column-0 (top-level) ones. Locals are not what reviewers chase. */
const SURFACE = /^(?:export\b|[A-Za-z_]|pub\b)/;

/** Identifiers declared or removed on changed lines. */
export function changedSymbols(files: FileDiff[]): string[] {
  const syms = new Set<string>();
  for (const f of files) {
    if (isNoise(f.path) || f.binary || !isIndexedPath(f.path)) {
      continue;
    }
    for (const line of f.touched) {
      if (!SURFACE.test(line)) {
        continue;
      }
      for (const m of line.matchAll(DECL)) {
        const name = m[1];
        if (name && !STOP.has(name)) {
          syms.add(name);
        }
      }
    }
  }
  return [...syms].sort();
}

export const symbolRegex = (sym: string): string => `\\b${sym}\\b`;

export const lineKey = (path: string, line: number): string => `${path}:${line}`;

/** Lines the diff itself already shows, as `path:line` keys. */
export function shownKeys(files: FileDiff[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const n of f.shown) {
      out.add(lineKey(f.path, n));
    }
  }
  return out;
}

/** Truth 1: every head line that mentions a changed symbol, minus lines the diff already shows. */
export function refTruth(snap: Snapshot, symbols: string[], shown: Set<string>): Set<string> {
  const out = new Set<string>();
  if (symbols.length === 0) {
    return out;
  }
  const re = new RegExp(symbols.map(symbolRegex).join("|"));
  for (const [path, lines] of snap.files) {
    lines.forEach((text, i) => {
      const key = lineKey(path, i + 1);
      if (re.test(text) && !shown.has(key)) {
        out.add(key);
      }
    });
  }
  return out;
}

export function chunksAt(snap: Snapshot, path: string, lines: Set<number>): Chunk[] {
  return snap.chunks.filter(
    (c) => c.file_path === path && [...lines].some((n) => n >= c.start_line && n <= c.end_line),
  );
}

/** Truth 2: the rest of each chunk that contains a changed line (the code a hunk sits in). */
export function ctxTruth(snap: Snapshot, files: FileDiff[], shown: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (isNoise(f.path) || f.binary || f.deleted) {
      continue;
    }
    for (const c of chunksAt(snap, f.path, f.changed)) {
      for (let n = c.start_line; n <= c.end_line; n++) {
        const key = lineKey(f.path, n);
        if (!shown.has(key)) {
          out.add(key);
        }
      }
    }
  }
  return out;
}

export function score(seen: Set<string>, truth: Set<string>): number {
  if (truth.size === 0) {
    return 1;
  }
  let hit = 0;
  for (const k of truth) {
    if (seen.has(k)) {
      hit++;
    }
  }
  return hit / truth.size;
}
