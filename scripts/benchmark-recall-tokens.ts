/**
 * Compare Miru full chunks vs Miru snippets vs ripgrep on recall@K and tokens.
 *
 * Usage:
 *   bun run scripts/benchmark-recall-tokens.ts
 *   bun run scripts/benchmark-recall-tokens.ts --repos miru-code,flask,gin
 */
import { relative } from "node:path";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { applySnippetsToResults, estimateResultTokens } from "../src/snippet.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

process.env.MIRU_SEARCH_V2 = "1";

const SNIPPET_LINES = 15;

const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with".split(
    " ",
  ),
);

const GREP_LINES_PER_FILE = 3;
const GREP_CONTEXT = 2;

function parseRepoFilter(): Set<string> | null {
  const idx = process.argv.indexOf("--repos");
  if (idx < 0 || !process.argv[idx + 1]) {
    return null;
  }
  return new Set(
    process.argv[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function estTokens(text: string): number {
  return Math.floor(text.length / 4);
}

function queryKeywords(query: string): string[] {
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

interface GrepFileHit {
  file: string;
  matchCount: number;
  output: string;
}

async function grepSearch(
  repoRoot: string,
  query: string,
  topK: number,
): Promise<{ files: string[]; hits: GrepFileHit[]; tokens: number; pattern: string | null }> {
  const keywords = queryKeywords(query);
  const pattern = buildGrepPattern(keywords);
  if (!pattern) {
    return { files: [], hits: [], tokens: 0, pattern: null };
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
  };
}

interface ArmMetrics {
  recallAtK: boolean;
  relevantFound: number;
  files: string[];
  tokens: number;
  ms: number;
}

interface QueryMetrics {
  query: string;
  category: string;
  relevant: string[];
  miruFull: ArmMetrics;
  miruSnippet: ArmMetrics;
  grep: ArmMetrics & { pattern: string | null };
}

function scoreRecall(
  files: string[],
  relevant: string[],
): {
  recallAtK: boolean;
  relevantFound: number;
} {
  let relevantFound = 0;
  for (const want of relevant) {
    if (files.some((f) => pathMatches(f, want))) {
      relevantFound++;
    }
  }
  return { recallAtK: relevantFound > 0, relevantFound };
}

function summarizeArm(rows: QueryMetrics[], key: "miruFull" | "miruSnippet" | "grep") {
  const n = rows.length || 1;
  return {
    recallAtK: rows.filter((r) => r[key].recallAtK).length / n,
    meanRelevantFound: rows.reduce((s, r) => s + r[key].relevantFound, 0) / n,
    meanTokens: rows.reduce((s, r) => s + r[key].tokens, 0) / n,
    meanMs: rows.reduce((s, r) => s + r[key].ms, 0) / n,
  };
}

async function evaluateRepo(
  bench: (typeof REPO_BENCHES)[number],
): Promise<{ name: string; language: string; queries: QueryMetrics[] }> {
  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  const queries: QueryMetrics[] = [];

  for (const spec of bench.queries) {
    const searchStart = performance.now();
    const results = dedupeResultsByFile(
      await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
    ).slice(0, TOP_K);
    const searchMs = performance.now() - searchStart;

    const files = results.map((r) => r.chunk.file_path);
    const recall = scoreRecall(files, spec.relevant);

    const miruFullTokens = estimateResultTokens(results);
    const snippetResults = applySnippetsToResults(results, spec.query, SNIPPET_LINES).map(
      (entry) => entry.result,
    );
    const miruSnippetTokens = estimateResultTokens(snippetResults);

    const grepStart = performance.now();
    const grep = await grepSearch(bench.path, spec.query, TOP_K);
    const grepMs = performance.now() - grepStart;
    const grepRecall = scoreRecall(grep.files, spec.relevant);

    queries.push({
      query: spec.query,
      category: spec.category,
      relevant: spec.relevant,
      miruFull: {
        ...recall,
        files,
        tokens: miruFullTokens,
        ms: searchMs,
      },
      miruSnippet: {
        ...recall,
        files,
        tokens: miruSnippetTokens,
        ms: searchMs,
      },
      grep: {
        ...grepRecall,
        files: grep.files,
        tokens: grep.tokens,
        pattern: grep.pattern,
        ms: grepMs,
      },
    });
  }

  return { name: bench.name, language: bench.language, queries };
}

const repoFilter = parseRepoFilter();
const benches = REPO_BENCHES.filter((b) => !repoFilter || repoFilter.has(b.name));
const available = [];
for (const bench of benches) {
  if (await pathExists(bench.path)) {
    available.push(bench);
  }
}

if (available.length === 0) {
  console.error("No repos available.");
  process.exit(1);
}

console.error(
  `Miru full vs snippet (±${SNIPPET_LINES} lines) vs grep — recall@${TOP_K}, repos=${available.length}\n`,
);

const allQueries: QueryMetrics[] = [];

for (const bench of available) {
  console.error(`--- ${bench.name} (${bench.language}) ---`);
  const result = await evaluateRepo(bench);
  allQueries.push(...result.queries);

  const full = summarizeArm(result.queries, "miruFull");
  const snippet = summarizeArm(result.queries, "miruSnippet");
  const grep = summarizeArm(result.queries, "grep");

  console.error(
    `  miru-full    recall=${(full.recallAtK * 100).toFixed(0)}%  tokens=${full.meanTokens.toFixed(0)}`,
  );
  console.error(
    `  miru-snippet recall=${(snippet.recallAtK * 100).toFixed(0)}%  tokens=${snippet.meanTokens.toFixed(0)}`,
  );
  console.error(
    `  grep         recall=${(grep.recallAtK * 100).toFixed(0)}%  tokens=${grep.meanTokens.toFixed(0)}`,
  );

  for (const q of result.queries) {
    console.error(
      `  [${q.category}] tokens full/snippet/grep: ${q.miruFull.tokens}/${q.miruSnippet.tokens}/${q.grep.tokens}`,
    );
  }
  console.error("");
}

const fullAgg = summarizeArm(allQueries, "miruFull");
const snippetAgg = summarizeArm(allQueries, "miruSnippet");
const grepAgg = summarizeArm(allQueries, "grep");

console.error("=== AGGREGATE ===");
console.error(
  `  miru-full    recall@${TOP_K}=${(fullAgg.recallAtK * 100).toFixed(0)}%  tokens/query=${fullAgg.meanTokens.toFixed(0)}`,
);
console.error(
  `  miru-snippet recall@${TOP_K}=${(snippetAgg.recallAtK * 100).toFixed(0)}%  tokens/query=${snippetAgg.meanTokens.toFixed(0)}`,
);
console.error(
  `  grep         recall@${TOP_K}=${(grepAgg.recallAtK * 100).toFixed(0)}%  tokens/query=${grepAgg.meanTokens.toFixed(0)}`,
);
console.error(
  `  snippet vs full: ${((1 - snippetAgg.meanTokens / fullAgg.meanTokens) * 100).toFixed(0)}% token reduction`,
);
console.error(
  `  snippet vs grep: recall ${((snippetAgg.recallAtK - grepAgg.recallAtK) * 100).toFixed(0)}pp  tokens ${(snippetAgg.meanTokens - grepAgg.meanTokens).toFixed(0)}`,
);

const snippetVsGrepRecall = snippetAgg.recallAtK - grepAgg.recallAtK;
const pass =
  snippetAgg.recallAtK >= fullAgg.recallAtK - 0.001 && snippetAgg.recallAtK >= grepAgg.recallAtK;

console.error(
  `\n${pass ? "PASS" : "NOTE"}: snippet maintains recall vs full and beats grep on recall`,
);

console.log(
  JSON.stringify({
    top_k: TOP_K,
    snippet_lines: SNIPPET_LINES,
    query_count: allQueries.length,
    miru_full: fullAgg,
    miru_snippet: snippetAgg,
    grep: grepAgg,
    pass,
    snippet_vs_full_token_reduction: 1 - snippetAgg.meanTokens / fullAgg.meanTokens,
    snippet_vs_grep_recall_pp: snippetVsGrepRecall,
    queries: allQueries,
  }),
);
