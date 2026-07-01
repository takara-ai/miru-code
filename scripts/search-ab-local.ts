/**
 * A/B compare search quality on this repo: MIRU_SEARCH_V2=0 (baseline) vs =1 (treatment).
 *
 * Usage:
 *   bun run scripts/search-ab-local.ts [--fresh]
 */
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import type { SearchResult } from "../src/types.ts";
import { dedupeResultsByFile } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const TOP_K = 3;

interface GoldenCase {
  query: string;
  expectFiles: string[];
  rejectFiles?: string[];
  expectContent?: RegExp;
}

const CASES: GoldenCase[] = [
  {
    query: "CLI entry point main command line interface",
    expectFiles: ["src/cli.ts", "package.json"],
    rejectFiles: ["src/installer/hooks/install.ts"],
    expectContent: /main\s*\(/,
  },
  {
    query: "where is cli-ui terminal output formatting",
    expectFiles: ["src/cli-ui.ts"],
    rejectFiles: ["src/help.ts"],
  },
  {
    query: "hybrid search ranking BM25 embedding score fusion",
    expectFiles: ["src/search.ts"],
  },
  {
    query: "how does install configure agents hooks",
    expectFiles: ["src/installer/installer.ts", "src/installer/hooks/install.ts"],
  },
];

interface CaseScore {
  query: string;
  hitAtK: boolean;
  mrr: number;
  falsePositive: boolean;
  contentMatch: boolean;
  topFiles: string[];
}

function scoreCase(results: SearchResult[], spec: GoldenCase): CaseScore {
  const deduped = dedupeResultsByFile(results);
  const topFiles = deduped.slice(0, TOP_K).map((r) => r.chunk.file_path);

  let mrr = 0;
  let hitAtK = false;
  for (let i = 0; i < topFiles.length; i++) {
    const file = topFiles[i];
    if (file && spec.expectFiles.includes(file)) {
      hitAtK = true;
      mrr = 1 / (i + 1);
      break;
    }
  }

  const falsePositive = (spec.rejectFiles ?? []).some((reject) => topFiles.includes(reject));

  let contentMatch = true;
  if (spec.expectContent) {
    contentMatch = deduped
      .slice(0, TOP_K)
      .some(
        (r) =>
          spec.expectFiles.includes(r.chunk.file_path) && spec.expectContent?.test(r.chunk.content),
      );
  }

  return {
    query: spec.query,
    hitAtK,
    mrr,
    falsePositive,
    contentMatch,
    topFiles,
  };
}

interface VariantSummary {
  variant: string;
  hitRate: number;
  meanMrr: number;
  falsePositiveRate: number;
  contentMatchRate: number;
  indexChunks: number;
  cases: CaseScore[];
}

async function runVariant(
  variant: "baseline" | "treatment",
  fresh: boolean,
): Promise<VariantSummary> {
  process.env.MIRU_SEARCH_V2 = variant === "baseline" ? "0" : "1";

  if (fresh) {
    await clearCache(REPO_ROOT);
  }

  const index = await MiruIndex.fromPath(REPO_ROOT, ["code"]);
  const cases: CaseScore[] = [];

  for (const spec of CASES) {
    const results = await index.search({ query: spec.query, topK: TOP_K, rerank: true });
    cases.push(scoreCase(results, spec));
  }

  const n = cases.length;
  return {
    variant,
    hitRate: cases.filter((c) => c.hitAtK).length / n,
    meanMrr: cases.reduce((sum, c) => sum + c.mrr, 0) / n,
    falsePositiveRate: cases.filter((c) => c.falsePositive).length / n,
    contentMatchRate: cases.filter((c) => c.contentMatch).length / n,
    indexChunks: index.chunks.length,
    cases,
  };
}

const reuseCache = process.argv.includes("--reuse-cache");

console.error(`Search A/B on ${REPO_ROOT} (top_k=${TOP_K}, rebuild=${!reuseCache})\n`);

const baseline = await runVariant("baseline", !reuseCache);
const treatment = await runVariant("treatment", !reuseCache);

function printSummary(summary: VariantSummary): void {
  console.error(
    `=== ${summary.variant.toUpperCase()} (MIRU_SEARCH_V2=${summary.variant === "baseline" ? "0" : "1"}) ===`,
  );
  console.error(`  chunks: ${summary.indexChunks}`);
  console.error(`  hit@${TOP_K}: ${(summary.hitRate * 100).toFixed(0)}%`);
  console.error(`  MRR: ${summary.meanMrr.toFixed(3)}`);
  console.error(`  false-positive@${TOP_K}: ${(summary.falsePositiveRate * 100).toFixed(0)}%`);
  console.error(`  content-match: ${(summary.contentMatchRate * 100).toFixed(0)}%`);
  for (const c of summary.cases) {
    console.error(
      `  ${c.hitAtK ? "OK" : "MISS"} mrr=${c.mrr.toFixed(2)} fp=${c.falsePositive ? "yes" : "no"}  q=${JSON.stringify(c.query)}`,
    );
    console.error(`      top: ${c.topFiles.join(", ")}`);
  }
  console.error("");
}

printSummary(baseline);
printSummary(treatment);

const delta = {
  hitRate: treatment.hitRate - baseline.hitRate,
  meanMrr: treatment.meanMrr - baseline.meanMrr,
  falsePositiveRate: treatment.falsePositiveRate - baseline.falsePositiveRate,
  contentMatchRate: treatment.contentMatchRate - baseline.contentMatchRate,
};

console.error("=== DELTA (treatment - baseline) ===");
console.error(
  `  hit@${TOP_K}: ${delta.hitRate >= 0 ? "+" : ""}${(delta.hitRate * 100).toFixed(0)}pp`,
);
console.error(`  MRR: ${delta.meanMrr >= 0 ? "+" : ""}${delta.meanMrr.toFixed(3)}`);
console.error(
  `  false-positive@${TOP_K}: ${delta.falsePositiveRate <= 0 ? "" : "+"}${(delta.falsePositiveRate * 100).toFixed(0)}pp`,
);
console.error(
  `  content-match: ${delta.contentMatchRate >= 0 ? "+" : ""}${(delta.contentMatchRate * 100).toFixed(0)}pp`,
);

console.log(
  JSON.stringify({
    repo: REPO_ROOT,
    top_k: TOP_K,
    baseline,
    treatment,
    delta,
  }),
);
