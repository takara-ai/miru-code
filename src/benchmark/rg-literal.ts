/** Exact-literal ripgrep baseline for locate benchmarking. */

import { relative } from "node:path";
import { countTokens } from "../token-count.ts";
import { RG_EXCLUDE_ARGS, selectBenchmarkSearchTool, spawnBenchmarkSearch } from "./grep.ts";

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
  const tool = selectBenchmarkSearchTool();
  if (!tool) {
    throw new Error("No search tool found in PATH (tried rg, grep, and findstr on Windows)");
  }
  const start = performance.now();
  const text = await spawnBenchmarkSearch(
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
      options.paths,
    ),
    tool === "findstr" ? repoRoot : undefined,
  );
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
  tool: "rg" | "grep" | "findstr",
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
  const args = ["findstr", "/S", "/N", "/P"];
  for (const l of literals) {
    args.push(`/C:${l}`);
  }
  args.push("*");
  if (ignoreCase) {
    args.splice(4, 0, "/I");
  }
  return args;
}
