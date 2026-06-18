/**
 * Compare recall@K: structural chunking (MIRU_AST_CHUNKING=0) vs AST (default).
 *
 * Usage:
 *   bun run scripts/benchmark-chunker-recall.ts
 *   bun run scripts/benchmark-chunker-recall.ts --repos miru-code,flask,gin
 */
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

process.env.MIRU_SEARCH_V2 = "1";

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

interface QueryResult {
  query: string;
  category: string;
  recallAtK: boolean;
  relevantFound: number;
  relevantTotal: number;
  topFiles: string[];
}

interface ArmResult {
  chunks: number;
  queries: QueryResult[];
  recallAtK: number;
  meanRelevantFound: number;
}

async function evaluateArm(bench: (typeof REPO_BENCHES)[number], ast: boolean): Promise<ArmResult> {
  process.env.MIRU_AST_CHUNKING = ast ? "1" : "0";
  await clearCache(bench.path);

  const index = await MiruIndex.fromPath(bench.path, ["code"]);

  const queries: QueryResult[] = [];
  for (const spec of bench.queries) {
    const results = dedupeResultsByFile(
      await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
    ).slice(0, TOP_K);
    const files = results.map((r) => r.chunk.file_path);

    let relevantFound = 0;
    for (const want of spec.relevant) {
      if (files.some((f) => pathMatches(f, want))) {
        relevantFound++;
      }
    }

    queries.push({
      query: spec.query,
      category: spec.category,
      recallAtK: relevantFound > 0,
      relevantFound,
      relevantTotal: spec.relevant.length,
      topFiles: files,
    });
  }

  const n = queries.length || 1;
  return {
    chunks: index.chunks.length,
    queries,
    recallAtK: queries.filter((q) => q.recallAtK).length / n,
    meanRelevantFound: queries.reduce((s, q) => s + q.relevantFound, 0) / n,
  };
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
  console.error("No benchmark repos available.");
  process.exit(1);
}

console.error(`Chunker recall@${TOP_K}: structural (MIRU_AST_CHUNKING=0) vs AST (default)\n`);

type RepoComparison = {
  name: string;
  language: string;
  structural: ArmResult;
  ast: ArmResult;
  regressions: string[];
};

const comparisons: RepoComparison[] = [];

for (const bench of available) {
  console.error(`--- ${bench.name} (${bench.language}) ---`);
  const structural = await evaluateArm(bench, false);
  const ast = await evaluateArm(bench, true);

  const regressions: string[] = [];
  for (let i = 0; i < bench.queries.length; i++) {
    const spec = bench.queries[i];
    const s = structural.queries[i];
    const a = ast.queries[i];
    if (!spec || !s || !a) {
      continue;
    }
    if (s.recallAtK && !a.recallAtK) {
      regressions.push(`[${spec.category}] ${spec.query}`);
    }
  }

  comparisons.push({ name: bench.name, language: bench.language, structural, ast, regressions });

  console.error(
    `  structural  recall=${(structural.recallAtK * 100).toFixed(0)}%  chunks=${structural.chunks}  rel=${structural.meanRelevantFound.toFixed(2)}`,
  );
  console.error(
    `  ast         recall=${(ast.recallAtK * 100).toFixed(0)}%  chunks=${ast.chunks}  rel=${ast.meanRelevantFound.toFixed(2)}`,
  );
  if (regressions.length > 0) {
    console.error(`  REGRESSIONS (${regressions.length}):`);
    for (const r of regressions) {
      console.error(`    - ${r}`);
    }
  } else {
    console.error("  no recall regressions");
  }
  console.error("");
}

const nQueries = comparisons.reduce((s, c) => s + c.structural.queries.length, 0);
const structuralRecall =
  comparisons.reduce((s, c) => s + c.structural.recallAtK * c.structural.queries.length, 0) /
  (nQueries || 1);
const astRecall =
  comparisons.reduce((s, c) => s + c.ast.recallAtK * c.ast.queries.length, 0) / (nQueries || 1);
const structuralRel =
  comparisons.reduce(
    (s, c) => s + c.structural.meanRelevantFound * c.structural.queries.length,
    0,
  ) / (nQueries || 1);
const astRel =
  comparisons.reduce((s, c) => s + c.ast.meanRelevantFound * c.ast.queries.length, 0) /
  (nQueries || 1);
const allRegressions = comparisons.flatMap((c) =>
  c.regressions.map((r) => ({ repo: c.name, query: r })),
);

const pass = allRegressions.length === 0 && astRecall >= structuralRecall - 0.001;

console.error("=== AGGREGATE ===");
console.error(`  queries:     ${nQueries} across ${comparisons.length} repos`);
console.error(
  `  structural  recall@${TOP_K}=${(structuralRecall * 100).toFixed(1)}%  mean_rel=${structuralRel.toFixed(2)}`,
);
console.error(
  `  ast         recall@${TOP_K}=${(astRecall * 100).toFixed(1)}%  mean_rel=${astRel.toFixed(2)}`,
);
console.error(
  `  delta       recall=${((astRecall - structuralRecall) * 100).toFixed(1)}pp  rel=${(astRel - structuralRel).toFixed(2)}`,
);
console.error(`\n${pass ? "PASS" : "FAIL"}: ${allRegressions.length} per-query regressions`);

console.log(
  JSON.stringify({
    top_k: TOP_K,
    query_count: nQueries,
    repo_count: comparisons.length,
    structural: { recall_at_k: structuralRecall, mean_relevant_found: structuralRel },
    ast: { recall_at_k: astRecall, mean_relevant_found: astRel },
    delta_recall_pp: astRecall - structuralRecall,
    regressions: allRegressions,
    pass,
    repos: comparisons.map((c) => ({
      name: c.name,
      language: c.language,
      structural: {
        recall_at_k: c.structural.recallAtK,
        chunks: c.structural.chunks,
        mean_relevant_found: c.structural.meanRelevantFound,
      },
      ast: {
        recall_at_k: c.ast.recallAtK,
        chunks: c.ast.chunks,
        mean_relevant_found: c.ast.meanRelevantFound,
      },
      regressions: c.regressions,
    })),
  }),
);
