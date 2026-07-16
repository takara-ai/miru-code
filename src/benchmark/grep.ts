/** Native grep baseline for Miru benchmark comparisons. */

import { relative } from "node:path";
import { countTokens } from "../token-count.ts";

const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with".split(
    " ",
  ),
);

export const GREP_LINES_PER_FILE = 3;
export const GREP_CONTEXT = 2;

/** Shared `-g` excludes for ripgrep baselines (search + locate). */
export const RG_EXCLUDE_ARGS = [
  "-g",
  "!node_modules",
  "-g",
  "!.git",
  "-g",
  "!tokenizer",
  "-g",
  "!tokenizer/**",
] as const;

export interface GrepFileHit {
  file: string;
  matchCount: number;
  output: string;
}

export interface GrepSearchResult {
  files: string[];
  hits: GrepFileHit[];
  tokens: number;
  pattern: string | null;
  keywords: string[];
}

export type BenchmarkSearchTool = "rg" | "grep" | "findstr";

export function selectBenchmarkSearchTool(options?: {
  platform?: NodeJS.Platform;
  hasRg?: boolean;
  hasGrep?: boolean;
  hasFindstr?: boolean;
}): BenchmarkSearchTool | null {
  const platform = options?.platform ?? process.platform;
  const hasRg = options?.hasRg ?? Bun.which("rg") != null;
  const hasGrep = options?.hasGrep ?? Bun.which("grep") != null;
  const hasFindstr = options?.hasFindstr ?? Bun.which("findstr") != null;
  if (hasRg) {
    return "rg";
  }
  if (hasGrep) {
    return "grep";
  }
  if (platform === "win32" && hasFindstr) {
    return "findstr";
  }
  return null;
}
export function queryKeywords(query: string): string[] {
  const words = (query.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const unique = [...new Set(words)];
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 6);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildGrepPattern(keywords: string[]): string | null {
  if (keywords.length === 0) {
    return null;
  }
  return keywords.map(escapeRegex).join("|");
}

function normalizeRepoFile(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath).replace(/\\/g, "/");
  return rel.startsWith("../") ? filePath.replace(/\\/g, "/") : rel;
}

export async function grepSearch(
  repoRoot: string,
  query: string,
  topK: number,
): Promise<GrepSearchResult> {
  const keywords = queryKeywords(query);
  const pattern = buildGrepPattern(keywords);
  if (!pattern) {
    return { files: [], hits: [], tokens: 0, pattern: null, keywords };
  }

  const tool = selectBenchmarkSearchTool();
  if (!tool) {
    throw new Error("No search tool found in PATH (tried rg, grep, and findstr on Windows)");
  }

  const ranked =
    tool === "rg"
      ? await rgRankedMatches(repoRoot, pattern, topK)
      : tool === "grep"
        ? await grepRankedMatches(repoRoot, pattern, topK)
        : await findstrRankedMatches(repoRoot, keywords, topK);

  const hits: GrepFileHit[] = [];
  let tokens = 0;

  for (const row of ranked) {
    const output =
      tool === "rg"
        ? await rgFilePreview(row.absPath, pattern)
        : tool === "grep"
          ? await grepFilePreview(row.absPath, pattern)
          : await findstrFilePreview(row.absPath, keywords);
    hits.push({ file: row.file, matchCount: row.matchCount, output });
    tokens += countTokens(output);
  }

  return {
    files: ranked.map((r) => r.file),
    hits,
    tokens,
    pattern,
    keywords,
  };
}

async function rgRankedMatches(repoRoot: string, pattern: string, topK: number) {
  const countProc = Bun.spawn(
    ["rg", "-i", "--count-matches", pattern, repoRoot, ...RG_EXCLUDE_ARGS],
    { stdout: "pipe", stderr: "pipe" },
  );
  const countText = await new Response(countProc.stdout).text();
  await countProc.exited;
  return parseCountMatches(repoRoot, countText, topK);
}

async function grepRankedMatches(repoRoot: string, pattern: string, topK: number) {
  const countProc = Bun.spawn(
    [
      "grep",
      "-R",
      "-I",
      "-i",
      "-E",
      "-o",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=tokenizer",
      pattern,
      repoRoot,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const countText = await new Response(countProc.stdout).text();
  await countProc.exited;
  const counts = new Map<string, number>();
  for (const line of countText.split("\n")) {
    if (!line) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const absPath = line.slice(0, colon);
    counts.set(absPath, (counts.get(absPath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([absPath, matchCount]) => ({
      file: normalizeRepoFile(repoRoot, absPath),
      absPath,
      matchCount,
    }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, topK);
}

async function findstrRankedMatches(repoRoot: string, keywords: string[], topK: number) {
  const counts = new Map<string, number>();
  for (const keyword of keywords) {
    const proc = Bun.spawn(
      ["findstr", "/S", "/N", "/I", "/P", `/C:${keyword}`, "*"],
      { stdout: "pipe", stderr: "pipe", cwd: repoRoot },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = /^(.+?):\d+:/.exec(line);
      if (!m?.[1]) {
        continue;
      }
      const absPath = `${repoRoot}/${m[1]}`.replace(/\\/g, "/");
      if (
        absPath.includes("/node_modules/") ||
        absPath.includes("/.git/") ||
        absPath.includes("/tokenizer/")
      ) {
        continue;
      }
      counts.set(absPath, (counts.get(absPath) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([absPath, matchCount]) => ({
      file: normalizeRepoFile(repoRoot, absPath),
      absPath,
      matchCount,
    }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, topK);
}

function parseCountMatches(repoRoot: string, countText: string, topK: number) {
  return countText
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const colon = line.lastIndexOf(":");
      if (colon < 0) {
        return null;
      }
      const absPath = line.slice(0, colon);
      const matchCount = Number(line.slice(colon + 1));
      if (!Number.isFinite(matchCount)) {
        return null;
      }
      return {
        file: normalizeRepoFile(repoRoot, absPath),
        absPath,
        matchCount,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, topK);
}

async function rgFilePreview(absPath: string, pattern: string): Promise<string> {
  const proc = Bun.spawn(
    ["rg", "-i", "-n", "-C", String(GREP_CONTEXT), "-m", String(GREP_LINES_PER_FILE), pattern, absPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

async function grepFilePreview(absPath: string, pattern: string): Promise<string> {
  const proc = Bun.spawn(
    ["grep", "-I", "-i", "-n", "-E", "-C", String(GREP_CONTEXT), "-m", String(GREP_LINES_PER_FILE), pattern, absPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

async function findstrFilePreview(absPath: string, keywords: string[]): Promise<string> {
  const args = ["findstr", "/N", "/I", "/P", ...keywords.map((k) => `/C:${k}`), absPath];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}
