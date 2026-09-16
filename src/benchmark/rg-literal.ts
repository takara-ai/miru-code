/** Exact-literal ripgrep baseline for locate benchmarking. */

import { relative } from "node:path";
import { countTokens } from "../token-count.ts";
import { RG_EXCLUDE_ARGS, selectBenchmarkSearchTool, spawnBenchmarkSearch } from "./grep.ts";

/** Keep each native-search invocation well below platform command-line limits. */
const MAX_LITERAL_PATH_ARGUMENT_CHARS = 4_096;

export interface RgLiteralOutput {
  text: string;
  tokens: number;
  latency_ms: number;
  n: number;
  files: number;
}

export interface RgLiteralOptions {
  context?: number;
  maxCount?: number;
  ignoreCase?: boolean;
  /** Return per-file match counts rather than matching lines. */
  countOnly?: boolean;
  /** Gitignore-style globs included by the comparable locate call. */
  include?: string[];
  /** Gitignore-style globs excluded by the comparable locate call. */
  exclude?: string[];
  /** Absolute or repo-relative files in the same corpus as the compared tool. */
  paths?: string[];
}

/**
 * `findstr` cannot reproduce the scoped, contextual, count-mode literal baseline.
 * Do not silently substitute it and report the result as an equivalent grep comparison.
 */
export function selectComparableLiteralSearchTool(
  options?: Parameters<typeof selectBenchmarkSearchTool>[0],
): "rg" | "grep" | null {
  const tool = selectBenchmarkSearchTool(options);
  return tool === "rg" || tool === "grep" ? tool : null;
}

/** Split an indexed corpus into safe native-command argument batches. */
export function batchLiteralPaths(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const path of paths) {
    const nextChars = chars + path.length + 1;
    if (batch.length > 0 && nextChars > MAX_LITERAL_PATH_ARGUMENT_CHARS) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(path);
    chars += path.length + 1;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/** Count match lines (path:line:…) and unique files from `rg -n` output. */
export function parseRgLiteralStats(text: string, repoRoot: string): { n: number; files: number } {
  const files = new Set<string>();
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("--")) {
      continue;
    }
    // path:line:content or path-line-content for context, including Windows drive letters.
    const parsed = parsePathLinePrefix(line);
    if (!parsed) {
      continue;
    }
    files.add(relative(repoRoot, parsed.path).replaceAll("\\", "/"));
    if (line.includes(`${parsed.path}:${parsed.line}:`)) {
      n += 1;
    }
  }
  return { n, files: files.size };
}

function parsePathLinePrefix(line: string): { path: string; line: number } | null {
  for (let i = 0; i < line.length; i++) {
    const delim = line[i];
    if (delim !== ":" && delim !== "-") {
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j] >= "0" && line[j] <= "9") {
      j++;
    }
    if (j === i + 1 || j >= line.length) {
      continue;
    }
    const trailing = line[j];
    if (trailing !== ":" && trailing !== "-") {
      continue;
    }
    const lineNo = Number(line.slice(i + 1, j));
    if (!Number.isFinite(lineNo)) {
      continue;
    }
    return { path: line.slice(0, i), line: lineNo };
  }
  return null;
}

function parseCountStats(text: string, repoRoot: string): { n: number; files: number } {
  let n = 0;
  let files = 0;
  for (const line of text.split("\n")) {
    const colon = line.lastIndexOf(":");
    if (colon < 0) {
      continue;
    }
    const count = Number(line.slice(colon + 1));
    if (!Number.isFinite(count) || count <= 0) {
      continue;
    }
    // Ensure this is a path under the requested root, rather than an arbitrary line.
    const path = line.slice(0, colon);
    if (relative(repoRoot, path).startsWith("..")) {
      continue;
    }
    n += count;
    files += 1;
  }
  return { n, files };
}

export async function rgLiteralOutput(
  repoRoot: string,
  literal: string | readonly string[],
  options: RgLiteralOptions = {},
): Promise<RgLiteralOutput> {
  const literals = Array.isArray(literal) ? literal : [literal as string];
  const context = options.context ?? 0;
  const maxCount = options.maxCount ?? 20;
  const tool = selectComparableLiteralSearchTool();
  if (!tool) {
    throw new Error(
      "A comparable literal benchmark requires rg or compatible grep; findstr cannot preserve locate scope, context, and count semantics.",
    );
  }
  const start = performance.now();
  const pathBatches = options.paths?.length ? batchLiteralPaths(options.paths) : [undefined];
  const output: string[] = [];
  for (const paths of pathBatches) {
    output.push(
      await spawnBenchmarkSearch(
        buildLiteralArgs(
          tool,
          repoRoot,
          literals,
          context,
          maxCount,
          !!options.ignoreCase,
          options.countOnly,
          options.include,
          options.exclude,
          paths,
        ),
      ),
    );
  }
  const text = output.filter(Boolean).join("\n");
  const latency_ms = performance.now() - start;
  const stats = options.countOnly
    ? parseCountStats(text, repoRoot)
    : parseRgLiteralStats(text, repoRoot);
  return { text, tokens: countTokens(text), latency_ms, ...stats };
}

/**
 * OR-matches every literal, mirroring what an agent without `locate` would have to run
 * to get the same recall as `literals`/`match_variants` (one pattern isn't equivalent).
 */
function buildLiteralArgs(
  tool: "rg" | "grep",
  repoRoot: string,
  literals: readonly string[],
  context: number,
  maxCount: number,
  ignoreCase: boolean,
  countOnly = false,
  include: string[] = [],
  exclude: string[] = [],
  paths?: string[],
): string[] {
  if (tool === "rg") {
    const args = ["rg", "-F", "-n", "--no-heading", ...RG_EXCLUDE_ARGS];
    if (countOnly) {
      args.splice(2, 2, "--count");
    }
    for (const glob of include) {
      args.push("-g", glob);
    }
    for (const glob of exclude) {
      args.push("-g", `!${glob}`);
    }
    if (ignoreCase) {
      args.push("-i");
    }
    if (context > 0) {
      args.push("-C", String(context));
    }
    if (maxCount > 0) {
      args.push("-m", String(maxCount));
    }
    for (const l of literals) {
      args.push("-e", l);
    }
    args.push(...(paths?.length ? paths : [repoRoot]));
    return args;
  }
  if (tool === "grep") {
    const args = [
      "grep",
      "-R",
      "-I",
      "-F",
      "-n",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=tokenizer",
      "--exclude=*.map",
      "--exclude=*.min.js",
      "--exclude=*.min.css",
    ];
    for (const glob of include) {
      args.push(`--include=${glob}`);
    }
    for (const glob of exclude) {
      args.push(`--exclude=${glob}`);
    }
    if (countOnly) {
      args.push("-c");
    }
    if (ignoreCase) {
      args.push("-i");
    }
    if (context > 0) {
      args.push("-C", String(context));
    }
    if (maxCount > 0) {
      args.push("-m", String(maxCount));
    }
    for (const l of literals) {
      args.push("-e", l);
    }
    args.push(...(paths?.length ? paths : [repoRoot]));
    return args;
  }
  throw new Error(`Unsupported comparable literal benchmark tool: ${tool}`);
}
