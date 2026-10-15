/**
 * Shared corpus, query set, ground truth and scoring for the regex/glob benchmarks
 * (benchmark-regex-glob.ts: modeled tools; benchmark-regex-glob-live.ts: real Claude Code tools).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSource } from "../src/chunking/chunking.ts";
import { ensureParserInit } from "../src/chunking/grammars.ts";
import { walkFiles } from "../src/index/file-walker.ts";
import { detectLanguage, getExtensions, getFileStatus, readFileText } from "../src/index/files.ts";
import { type Chunk, defaultContentTypes } from "../src/types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Task = "regex-lines" | "regex-files" | "glob";
export type RegexQuery = { id: string; pattern: string; ignoreCase?: boolean };

export const REGEX_QUERIES: RegexQuery[] = [
  { id: "mcp-consts", pattern: "export const MCP_[A-Z_]+ =" },
  { id: "async-fns", pattern: "async function \\w+\\(" },
  { id: "todo-markers", pattern: "TODO|FIXME|HACK|XXX" },
  { id: "new-regexp", pattern: "new RegExp\\(" },
  { id: "env-miru", pattern: "process\\.env\\.MIRU_\\w+" },
  { id: "exported-fns", pattern: "^export (async )?function " },
  { id: "catch-binding", pattern: "catch \\(\\w+\\) \\{" },
  { id: "throw-error", pattern: "throw new \\w*Error\\(" },
  { id: "promise-types", pattern: ": Promise<[^>]+>" },
  { id: "rel-imports", pattern: 'import .* from "\\.\\./' },
  { id: "expect-tobe", pattern: "\\bexpect\\(.*\\)\\.toBe\\(" },
  { id: "anthropic-meta", pattern: "anthropic/\\w+" },
  { id: "mcp-server-ci", pattern: "mcp.*server", ignoreCase: true },
  { id: "semver", pattern: "\\d+\\.\\d+\\.\\d+" },
];

export const GLOB_QUERIES: string[] = [
  "**/*.test.ts",
  "src/**/*.ts",
  "scripts/benchmark-*.ts",
  "**/SKILL.md",
  "src/installer/**",
  "grammars/*.wasm",
  "**/*.md",
  "src/mcp/*.ts",
  "docs/*.md",
  "**/*.json",
  "tests/**/*mcp*.test.ts",
  "examples/**/*.ts",
];

export async function repoPaths(): Promise<string[]> {
  const out = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT });
  return new TextDecoder()
    .decode(out.stdout)
    .split("\0")
    .filter((p) => p.length > 0 && existsSync(join(ROOT, p)));
}

export async function trackedTextFiles(paths: string[]): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  for (const path of paths) {
    try {
      const file = Bun.file(join(ROOT, path));
      if (file.size > 2_000_000) {
        continue;
      }
      const text = await file.text();
      if (text.includes("\u0000")) {
        continue;
      }
      files.set(path, text.split("\n"));
    } catch {
      // deleted-but-listed or unreadable: not part of the corpus
    }
  }
  return files;
}

export async function chunkRepoOffline(): Promise<Chunk[]> {
  await ensureParserInit();
  const chunks: Chunk[] = [];
  for await (const filePath of walkFiles(ROOT, getExtensions(defaultContentTypes()))) {
    if ((await getFileStatus(filePath)) !== "valid") {
      continue;
    }
    const rel = filePath.slice(ROOT.length + 1).replaceAll("\\", "/");
    chunks.push(
      ...(await chunkSource(await readFileText(filePath), rel, detectLanguage(filePath))),
    );
  }
  return chunks;
}

export function truthLines(files: Map<string, string[]>, q: RegexQuery): Set<string> {
  const re = new RegExp(q.pattern, q.ignoreCase ? "i" : "");
  const out = new Set<string>();
  for (const [path, lines] of files) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        out.add(`${path}:${i + 1}`);
      }
    });
  }
  return out;
}

export function truthFiles(files: Map<string, string[]>, q: RegexQuery): Set<string> {
  return new Set([...truthLines(files, q)].map((k) => k.slice(0, k.lastIndexOf(":"))));
}

/** Glob truth covers every file (binaries included), as Claude's Glob would list them. */
export function truthGlob(paths: string[], pattern: string): Set<string> {
  const glob = new Bun.Glob(pattern);
  return new Set(paths.filter((p) => glob.match(p)));
}

export function score(pred: Set<string>, truth: Set<string>) {
  let tp = 0;
  for (const item of pred) {
    if (truth.has(item)) {
      tp++;
    }
  }
  const precision = pred.size === 0 ? 1 : tp / pred.size;
  const recall = truth.size === 0 ? 1 : tp / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, precision, recall, f1 };
}
