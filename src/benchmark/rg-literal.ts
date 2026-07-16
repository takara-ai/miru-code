/** Exact-literal ripgrep baseline for locate benchmarking. */

import { relative } from "node:path";
import { countTokens } from "../token-count.ts";
import { RG_EXCLUDE_ARGS } from "./grep.ts";

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
    // path:line:content or path-line-content for context
    const m = /^(.+?)[:|-](\d+)[:|-]/.exec(line);
    if (!m?.[1]) {
      continue;
    }
    files.add(relative(repoRoot, m[1]).replaceAll("\\", "/"));
    if (line.includes(`${m[1]}:${m[2]}:`)) {
      n += 1;
    }
  }
  return { n, files: files.size };
}

export async function rgLiteralOutput(
  repoRoot: string,
  literal: string,
  options: {
    context?: number;
    maxCount?: number;
    ignoreCase?: boolean;
  } = {},
): Promise<RgLiteralOutput> {
  const context = options.context ?? 0;
  const maxCount = options.maxCount ?? 20;
  const args = ["rg", "-F", "-n", "--no-heading", ...RG_EXCLUDE_ARGS];
  if (options.ignoreCase) {
    args.push("-i");
  }
  if (context > 0) {
    args.push("-C", String(context));
  }
  if (maxCount > 0) {
    args.push("-m", String(maxCount));
  }
  args.push(literal, repoRoot);

  const start = performance.now();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const latency_ms = performance.now() - start;
  const stats = parseRgLiteralStats(text, repoRoot);
  return { text, tokens: countTokens(text), latency_ms, ...stats };
}
