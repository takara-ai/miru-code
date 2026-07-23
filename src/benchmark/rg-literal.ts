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

export async function rgLiteralOutput(
  repoRoot: string,
  literal: string | readonly string[],
  options: {
    context?: number;
    maxCount?: number;
    ignoreCase?: boolean;
  } = {},
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
    buildLiteralArgs(tool, repoRoot, literals, context, maxCount, !!options.ignoreCase),
    tool === "findstr" ? repoRoot : undefined,
  );
  const latency_ms = performance.now() - start;
  const stats = parseRgLiteralStats(text, repoRoot);
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
): string[] {
  if (tool === "rg") {
    const args = ["rg", "-F", "-n", "--no-heading", ...RG_EXCLUDE_ARGS];
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
    args.push(repoRoot);
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
    ];
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
    args.push(repoRoot);
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
