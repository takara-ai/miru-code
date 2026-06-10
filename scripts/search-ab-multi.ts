/**
 * Cross-repo A/B: MIRU_SEARCH_V2=0 (baseline) vs =1 (treatment).
 * Uses curated queries on ~/.cache/semble-bench checkouts (or --repo paths).
 *
 * Usage:
 *   bun run scripts/search-ab-multi.ts
 *   bun run scripts/search-ab-multi.ts --repos flask,axum,gin
 *   bun run scripts/search-ab-multi.ts --reuse-cache
 */
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import type { SearchResult } from "../src/types.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { ndcgAtK, pathMatches, type Target, targetRank } from "./benchmark-lib.ts";
import {
  type BenchQuery,
  pathExists,
  REPO_BENCHES,
  type RepoBench,
  TOP_K,
} from "./search-ab-queries.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

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

function toTargets(paths: string[]): Target[] {
  return paths.map((path) => ({ path, start_line: null, end_line: null }));
}

interface QueryScore {
  query: string;
  category: string;
  ndcg5: number;
  hitAt5: boolean;
  bestRank: number | null;
  topFiles: string[];
}

interface RepoResult {
  name: string;
  language: string;
  variant: "baseline" | "treatment";
  indexChunks: number;
  meanNdcg5: number;
  hitRate5: number;
  queries: QueryScore[];
}

function scoreQuery(results: SearchResult[], spec: BenchQuery): QueryScore {
  const deduped = dedupeResultsByFile(results);
  const topFiles = deduped.slice(0, TOP_K).map((r) => r.chunk.file_path);
  const targets = toTargets(spec.relevant);

  const ranks = targets.map((t) => targetRank(deduped, t)).filter((r): r is number => r != null);

  let bestRank: number | null = null;
  for (let i = 0; i < topFiles.length; i++) {
    const file = topFiles[i];
    if (file && spec.relevant.some((want) => pathMatches(file, want))) {
      bestRank = i + 1;
      break;
    }
  }

  return {
    query: spec.query,
    category: spec.category,
    ndcg5: ndcgAtK(ranks, spec.relevant.length, TOP_K),
    hitAt5: bestRank != null,
    bestRank,
    topFiles,
  };
}

async function evaluateRepo(
  bench: RepoBench,
  variant: "baseline" | "treatment",
  rebuild: boolean,
): Promise<RepoResult> {
  process.env.MIRU_SEARCH_V2 = variant === "baseline" ? "0" : "1";

  if (rebuild) {
    await clearCache(bench.path);
  }

  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  const queries: QueryScore[] = [];

  for (const spec of bench.queries) {
    const results = await index.search({ query: spec.query, topK: TOP_K, rerank: true });
    queries.push(scoreQuery(results, spec));
  }

  const n = queries.length;
  return {
    name: bench.name,
    language: bench.language,
    variant,
    indexChunks: index.chunks.length,
    meanNdcg5: queries.reduce((sum, q) => sum + q.ndcg5, 0) / n,
    hitRate5: queries.filter((q) => q.hitAt5).length / n,
    queries,
  };
}

function summarizeVariant(rows: RepoResult[]): {
  meanNdcg5: number;
  hitRate5: number;
  repos: number;
  queries: number;
} {
  const queries = rows.flatMap((r) => r.queries);
  return {
    meanNdcg5: queries.reduce((sum, q) => sum + q.ndcg5, 0) / queries.length,
    hitRate5: queries.filter((q) => q.hitAt5).length / queries.length,
    repos: rows.length,
    queries: queries.length,
  };
}

const repoFilter = parseRepoFilter();
const reuseCache = process.argv.includes("--reuse-cache");
const benches = REPO_BENCHES.filter((b) => !repoFilter || repoFilter.has(b.name));

const available = [];
for (const bench of benches) {
  if (await pathExists(bench.path)) {
    available.push(bench);
  } else {
    console.error(`SKIP ${bench.name}: missing path ${bench.path}`);
  }
}

if (available.length === 0) {
  console.error("No benchmark repos available. Check ~/.cache/semble-bench");
  process.exit(1);
}

console.error(
  `Multi-repo search A/B (top_k=${TOP_K}, repos=${available.length}, rebuild=${!reuseCache})\n`,
);

const baselineRows: RepoResult[] = [];
const treatmentRows: RepoResult[] = [];

for (const bench of available) {
  console.error(`--- ${bench.name} (${bench.language}) ---`);
  const baseline = await evaluateRepo(bench, "baseline", !reuseCache);
  const treatment = await evaluateRepo(bench, "treatment", !reuseCache);
  baselineRows.push(baseline);
  treatmentRows.push(treatment);

  const deltaNdcg = treatment.meanNdcg5 - baseline.meanNdcg5;
  const status = deltaNdcg >= -0.01 ? (deltaNdcg > 0.01 ? "BETTER" : "SAME") : "REGRESSED";

  console.error(
    `  baseline  ndcg@5=${baseline.meanNdcg5.toFixed(3)} hit@5=${(baseline.hitRate5 * 100).toFixed(0)}% chunks=${baseline.indexChunks}`,
  );
  console.error(
    `  treatment ndcg@5=${treatment.meanNdcg5.toFixed(3)} hit@5=${(treatment.hitRate5 * 100).toFixed(0)}% chunks=${treatment.indexChunks}`,
  );
  console.error(`  delta ndcg@5=${deltaNdcg >= 0 ? "+" : ""}${deltaNdcg.toFixed(3)}  [${status}]`);

  for (let i = 0; i < bench.queries.length; i++) {
    const bq = baseline.queries[i];
    const tq = treatment.queries[i];
    if (!bq || !tq) {
      continue;
    }
    if (tq.ndcg5 + 0.001 < bq.ndcg5) {
      console.error(
        `  REGRESSION q=${JSON.stringify(bq.query)} baseline=${bq.ndcg5.toFixed(3)} treatment=${tq.ndcg5.toFixed(3)}`,
      );
      console.error(`    baseline top: ${bq.topFiles.join(", ")}`);
      console.error(`    treatment top: ${tq.topFiles.join(", ")}`);
    }
  }
  console.error("");
}

const baselineSummary = summarizeVariant(baselineRows);
const treatmentSummary = summarizeVariant(treatmentRows);

const regressions = [];
for (let i = 0; i < available.length; i++) {
  const bench = available[i];
  const baseline = baselineRows[i];
  const treatment = treatmentRows[i];
  if (!bench || !baseline || !treatment) {
    continue;
  }
  if (treatment.meanNdcg5 + 0.01 < baseline.meanNdcg5) {
    regressions.push({
      repo: bench.name,
      baseline: baseline.meanNdcg5,
      treatment: treatment.meanNdcg5,
    });
  }
}

console.error("=== AGGREGATE ===");
console.error(
  `  baseline  ndcg@5=${baselineSummary.meanNdcg5.toFixed(3)} hit@5=${(baselineSummary.hitRate5 * 100).toFixed(0)}% (${baselineSummary.queries} queries, ${baselineSummary.repos} repos)`,
);
console.error(
  `  treatment ndcg@5=${treatmentSummary.meanNdcg5.toFixed(3)} hit@5=${(treatmentSummary.hitRate5 * 100).toFixed(0)}% (${treatmentSummary.queries} queries, ${treatmentSummary.repos} repos)`,
);
console.error(
  `  delta ndcg@5=${treatmentSummary.meanNdcg5 - baselineSummary.meanNdcg5 >= 0 ? "+" : ""}${(treatmentSummary.meanNdcg5 - baselineSummary.meanNdcg5).toFixed(3)}`,
);
console.error(`  repo regressions: ${regressions.length}`);

const pass =
  regressions.length === 0 && treatmentSummary.meanNdcg5 + 0.001 >= baselineSummary.meanNdcg5;
console.error(`\n${pass ? "PASS" : "FAIL"}: treatment same or better on all repos`);

console.log(
  JSON.stringify({
    top_k: TOP_K,
    pass,
    baseline: baselineSummary,
    treatment: treatmentSummary,
    regressions,
    by_repo: available.map((bench, i) => ({
      name: bench.name,
      language: bench.language,
      baseline: baselineRows[i],
      treatment: treatmentRows[i],
      delta_ndcg5: (treatmentRows[i]?.meanNdcg5 ?? 0) - (baselineRows[i]?.meanNdcg5 ?? 0),
    })),
  }),
);

process.exit(pass ? 0 : 1);
