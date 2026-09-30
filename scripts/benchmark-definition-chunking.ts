/**
 * A/B: greedy AST chunking (MIRU_AST_DEFINITIONS=0) vs definition-aware chunking (=1).
 * Reports file-level recall@K, MRR of the first relevant file, and returned chunk tokens.
 *
 * Usage:
 *   bun run scripts/benchmark-definition-chunking.ts [--repos flask,gin]
 */
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { pathExists, REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();
process.env.MIRU_SEARCH_V2 = "1";

const repoArg = process.argv.indexOf("--repos");
const filter = repoArg > 0 ? new Set((process.argv[repoArg + 1] ?? "").split(",")) : null;

interface Arm {
  chunks: number;
  found: number;
  total: number;
  hitQueries: number;
  queries: number;
  rrSum: number;
  tokens: number;
  misses: string[];
}

async function evaluate(bench: (typeof REPO_BENCHES)[number], definitions: boolean): Promise<Arm> {
  process.env.MIRU_AST_DEFINITIONS = definitions ? "1" : "0";
  await clearCache(bench.path);
  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  const arm: Arm = {
    chunks: index.chunks.length,
    found: 0,
    total: 0,
    hitQueries: 0,
    queries: 0,
    rrSum: 0,
    tokens: 0,
    misses: [],
  };
  for (const spec of bench.queries) {
    const results = dedupeResultsByFile(
      await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
    ).slice(0, TOP_K);
    const files = results.map((r) => r.chunk.file_path);
    const found = spec.relevant.filter((want) => files.some((f) => pathMatches(f, want)));
    const firstRank = files.findIndex((f) => spec.relevant.some((want) => pathMatches(f, want)));
    arm.queries++;
    arm.total += spec.relevant.length;
    arm.found += found.length;
    arm.hitQueries += found.length > 0 ? 1 : 0;
    arm.rrSum += firstRank >= 0 ? 1 / (firstRank + 1) : 0;
    arm.tokens += results.reduce((n, r) => n + Math.ceil(r.chunk.content.length / 4), 0);
    if (found.length === 0) {
      arm.misses.push(spec.query);
    }
  }
  return arm;
}

const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}%`;
const agg = { base: [] as Arm[], def: [] as Arm[] };

for (const bench of REPO_BENCHES) {
  if ((filter && !filter.has(bench.name)) || !(await pathExists(bench.path))) {
    continue;
  }
  const base = await evaluate(bench, false);
  const def = await evaluate(bench, true);
  agg.base.push(base);
  agg.def.push(def);
  console.error(
    `${bench.name.padEnd(10)} base recall=${pct(base.hitQueries, base.queries)} mrr=${(base.rrSum / base.queries).toFixed(3)} chunks=${base.chunks} | def recall=${pct(def.hitQueries, def.queries)} mrr=${(def.rrSum / def.queries).toFixed(3)} chunks=${def.chunks}`,
  );
}

function sum(arms: Arm[]) {
  const t = arms.reduce(
    (a, x) => ({
      q: a.q + x.queries,
      hit: a.hit + x.hitQueries,
      found: a.found + x.found,
      total: a.total + x.total,
      rr: a.rr + x.rrSum,
      tok: a.tok + x.tokens,
      chunks: a.chunks + x.chunks,
    }),
    { q: 0, hit: 0, found: 0, total: 0, rr: 0, tok: 0, chunks: 0 },
  );
  return {
    queries: t.q,
    recall_any: t.hit / t.q,
    recall_all_relevant: t.found / t.total,
    mrr: t.rr / t.q,
    tokens_per_query: t.tok / t.q,
    chunks: t.chunks,
  };
}

console.log(
  JSON.stringify({ top_k: TOP_K, base: sum(agg.base), definitions: sum(agg.def) }, null, 2),
);
