/**
 * Head-to-head: Miru MCP-equivalent search (V2 + snippets) vs keyword ripgrep.
 *
 * Usage:
 *   bun run benchmark:vs-grep
 *   bun run benchmark:vs-grep -- --repos gin,flask,axum
 *   bun run benchmark:vs-grep -- --json
 */
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { applySnippetsToResults, estimateResultTokens } from "../src/snippet.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { grepSearch } from "./benchmark-grep.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

process.env.MIRU_SEARCH_V2 = "1";

type Winner = "miru" | "grep" | "tie" | "both-miss";

interface QueryResult {
  repo: string;
  language: string;
  category: string;
  query: string;
  relevant: string[];
  miru: {
    recall: boolean;
    relevantFound: number;
    firstRelevantRank: number | null;
    topFiles: string[];
    tokens: number;
    ms: number;
  };
  grep: {
    recall: boolean;
    relevantFound: number;
    firstRelevantRank: number | null;
    topFiles: string[];
    tokens: number;
    pattern: string | null;
    keywords: string[];
    ms: number;
  };
  winner: Winner;
}

function parseArgs(): { repos: Set<string> | null; json: boolean } {
  const argv = process.argv.slice(2);
  let repos: Set<string> | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repos" && argv[i + 1]) {
      repos = new Set(
        argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { repos, json };
}

function scoreFiles(
  files: string[],
  relevant: string[],
): {
  recall: boolean;
  relevantFound: number;
  firstRelevantRank: number | null;
} {
  let relevantFound = 0;
  let firstRelevantRank: number | null = null;
  for (const want of relevant) {
    const idx = files.findIndex((f) => pathMatches(f, want));
    if (idx >= 0) {
      relevantFound++;
      if (firstRelevantRank == null || idx + 1 < firstRelevantRank) {
        firstRelevantRank = idx + 1;
      }
    }
  }
  return { recall: relevantFound > 0, relevantFound, firstRelevantRank };
}

function pickWinner(
  miru: { recall: boolean; firstRelevantRank: number | null },
  grep: { recall: boolean; firstRelevantRank: number | null },
): Winner {
  if (!miru.recall && !grep.recall) {
    return "both-miss";
  }
  if (miru.recall && !grep.recall) {
    return "miru";
  }
  if (grep.recall && !miru.recall) {
    return "grep";
  }
  const miruRank = miru.firstRelevantRank ?? TOP_K + 1;
  const grepRank = grep.firstRelevantRank ?? TOP_K + 1;
  if (miruRank < grepRank) {
    return "miru";
  }
  if (grepRank < miruRank) {
    return "grep";
  }
  return "tie";
}

async function evaluateQuery(
  repo: string,
  language: string,
  repoPath: string,
  index: MiruIndex,
  spec: (typeof REPO_BENCHES)[number]["queries"][number],
): Promise<QueryResult> {
  const miruStart = performance.now();
  const results = dedupeResultsByFile(
    await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
  ).slice(0, TOP_K);
  const miruMs = performance.now() - miruStart;
  const miruFiles = results.map((r) => r.chunk.file_path);
  const snippetResults = applySnippetsToResults(results, spec.query).map((e) => e.result);
  const miruScore = scoreFiles(miruFiles, spec.relevant);

  const grepStart = performance.now();
  const grep = await grepSearch(repoPath, spec.query, TOP_K);
  const grepMs = performance.now() - grepStart;
  const grepScore = scoreFiles(grep.files, spec.relevant);

  const winner = pickWinner(miruScore, grepScore);

  return {
    repo,
    language,
    category: spec.category,
    query: spec.query,
    relevant: spec.relevant,
    miru: {
      ...miruScore,
      topFiles: miruFiles,
      tokens: estimateResultTokens(snippetResults),
      ms: miruMs,
    },
    grep: {
      ...grepScore,
      topFiles: grep.files,
      tokens: grep.tokens,
      pattern: grep.pattern,
      keywords: grep.keywords,
      ms: grepMs,
    },
    winner,
  };
}

function formatRank(rank: number | null): string {
  return rank == null ? "—" : `#${rank}`;
}

function printTable(rows: QueryResult[]): void {
  console.log("");
  console.log(
    "repo".padEnd(12) +
      "cat".padEnd(14) +
      "winner".padEnd(10) +
      "miru".padEnd(6) +
      "grep".padEnd(6) +
      "rank M/G".padEnd(10) +
      "tok M/G".padEnd(14) +
      "query",
  );
  console.log("-".repeat(110));
  for (const row of rows) {
    const miruRecall = row.miru.recall ? "hit" : "miss";
    const grepRecall = row.grep.recall ? "hit" : "miss";
    const ranks = `${formatRank(row.miru.firstRelevantRank)}/${formatRank(row.grep.firstRelevantRank)}`;
    const tokens = `${row.miru.tokens}/${row.grep.tokens}`;
    const query = row.query.length > 42 ? `${row.query.slice(0, 39)}...` : row.query;
    console.log(
      row.repo.padEnd(12) +
        row.category.padEnd(14) +
        row.winner.padEnd(10) +
        miruRecall.padEnd(6) +
        grepRecall.padEnd(6) +
        ranks.padEnd(10) +
        tokens.padEnd(14) +
        query,
    );
  }
}

function summarize(rows: QueryResult[]) {
  const n = rows.length || 1;
  const wins = {
    miru: rows.filter((r) => r.winner === "miru").length,
    grep: rows.filter((r) => r.winner === "grep").length,
    tie: rows.filter((r) => r.winner === "tie").length,
    bothMiss: rows.filter((r) => r.winner === "both-miss").length,
  };
  return {
    queryCount: rows.length,
    topK: TOP_K,
    miruRecallAtK: rows.filter((r) => r.miru.recall).length / n,
    grepRecallAtK: rows.filter((r) => r.grep.recall).length / n,
    meanMiruTokens: rows.reduce((s, r) => s + r.miru.tokens, 0) / n,
    meanGrepTokens: rows.reduce((s, r) => s + r.grep.tokens, 0) / n,
    meanMiruMs: rows.reduce((s, r) => s + r.miru.ms, 0) / n,
    meanGrepMs: rows.reduce((s, r) => s + r.grep.ms, 0) / n,
    wins,
    rows,
  };
}

const { repos: repoFilter, json } = parseArgs();
const benches = REPO_BENCHES.filter((b) => !repoFilter || repoFilter.has(b.name));
const available = [];
for (const bench of benches) {
  if (await pathExists(bench.path)) {
    available.push(bench);
  }
}

if (available.length === 0) {
  console.error("No benchmark repos found under ~/.cache/miru-bench");
  console.error("Clone repos or run search-ab-multi setup first.");
  process.exit(1);
}

console.error(
  `Miru (MCP-equivalent: V2 + snippets) vs ripgrep — ${available.length} repos, top_k=${TOP_K}\n`,
);

const allRows: QueryResult[] = [];

for (const bench of available) {
  console.error(`Indexing ${bench.name} (${bench.language})...`);
  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  for (const spec of bench.queries) {
    allRows.push(await evaluateQuery(bench.name, bench.language, bench.path, index, spec));
  }
}

const summary = summarize(allRows);

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printTable(allRows);
  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Queries:     ${summary.queryCount}`);
  console.log(
    `Recall@${TOP_K}:  miru ${(summary.miruRecallAtK * 100).toFixed(0)}%  |  grep ${(summary.grepRecallAtK * 100).toFixed(0)}%  |  delta ${((summary.miruRecallAtK - summary.grepRecallAtK) * 100).toFixed(0)}pp`,
  );
  console.log(
    `Tokens/query: miru ${summary.meanMiruTokens.toFixed(0)}  |  grep ${summary.meanGrepTokens.toFixed(0)}  |  ${((1 - summary.meanMiruTokens / summary.meanGrepTokens) * 100).toFixed(0)}% smaller`,
  );
  console.log(
    `Latency:     miru ${summary.meanMiruMs.toFixed(0)}ms  |  grep ${summary.meanGrepMs.toFixed(0)}ms (grep excl. miru index build)`,
  );
  console.log(
    `Head-to-head: miru ${summary.wins.miru}  |  grep ${summary.wins.grep}  |  tie ${summary.wins.tie}  |  both miss ${summary.wins.bothMiss}`,
  );

  const miruOnly = allRows.filter((r) => r.winner === "miru");
  if (miruOnly.length > 0) {
    console.log("\nMiru-only wins (grep missed or ranked worse):");
    for (const row of miruOnly) {
      console.log(`  ${row.repo} [${row.category}]: ${row.query}`);
      console.log(`    miru: ${row.miru.topFiles.slice(0, 3).join(", ")}`);
      console.log(`    grep: ${row.grep.topFiles.slice(0, 3).join(", ") || "(none)"}`);
    }
  }
}
