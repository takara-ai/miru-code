/** Shared ripgrep baseline for Miru benchmark scripts. */

import { relative } from "node:path";

const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with".split(
    " ",
  ),
);

export const GREP_LINES_PER_FILE = 3;
export const GREP_CONTEXT = 2;

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

function estTokens(text: string): number {
  return Math.floor(text.length / 4);
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

  const countProc = Bun.spawn(
    ["rg", "-i", "--count-matches", pattern, repoRoot, "-g", "!node_modules", "-g", "!.git"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const countText = await new Response(countProc.stdout).text();
  await countProc.exited;

  const ranked = countText
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

  const hits: GrepFileHit[] = [];
  let tokens = 0;

  for (const row of ranked) {
    const contentProc = Bun.spawn(
      [
        "rg",
        "-i",
        "-n",
        "-C",
        String(GREP_CONTEXT),
        "-m",
        String(GREP_LINES_PER_FILE),
        pattern,
        row.absPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(contentProc.stdout).text();
    await contentProc.exited;
    hits.push({ file: row.file, matchCount: row.matchCount, output });
    tokens += estTokens(output);
  }

  return {
    files: ranked.map((r) => r.file),
    hits,
    tokens,
    pattern,
    keywords,
  };
}
