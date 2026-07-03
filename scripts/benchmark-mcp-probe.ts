/**
 * Probe benchmark MCP tool response shape, speeds, tokens, and accuracy.
 *
 * Usage:
 *   bun run scripts/benchmark-mcp-probe.ts
 *   bun run scripts/benchmark-mcp-probe.ts -- --json
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSearchBenchmark, benchmarkSearchComparison } from "../src/benchmark/compare.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { formatResults } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOP_K = 5;

const QUERIES = [
  {
    query: "CLI entry point main command line interface",
    relevant: ["src/cli.ts", "package.json"],
    category: "entry",
  },
  {
    query: "hybrid search ranking BM25 embedding score fusion",
    relevant: ["src/search.ts"],
    category: "architecture",
  },
  {
    query: "where is cli-ui terminal output formatting",
    relevant: ["src/cli-ui.ts"],
    category: "location",
  },
];

const jsonOnly = process.argv.includes("--json");

console.error(`Indexing ${REPO_ROOT}...`);
const indexStart = performance.now();
const index = await MiruIndex.fromPath(REPO_ROOT, ["code"]);
const indexMs = Math.round(performance.now() - indexStart);
console.error(`Index ready in ${indexMs}ms\n`);

const responses: Array<{
  category: string;
  tool_response: Record<string, unknown>;
  index_ms_first_run: number;
}> = [];

for (const spec of QUERIES) {
  const toolStart = performance.now();
  const comparison = await benchmarkSearchComparison({
    query: spec.query,
    repoPath: REPO_ROOT,
    index,
    topK: TOP_K,
    relevant: spec.relevant,
  });
  const payload = attachSearchBenchmark(
    formatResults(spec.query, comparison.results, { repoRoot: REPO_ROOT, snippet: true }),
    comparison.benchmark,
  );
  const toolMs = Math.round(performance.now() - toolStart);

  responses.push({
    category: spec.category,
    tool_response: {
      ...payload,
      _probe: { tool_wall_ms: toolMs, category: spec.category },
    },
    index_ms_first_run: indexMs,
  });
}

if (jsonOnly) {
  console.log(JSON.stringify({ repo: REPO_ROOT, top_k: TOP_K, responses }, null, 2));
} else {
  for (const entry of responses) {
    const b = entry.tool_response.benchmark as {
      miru: { workflow_tokens: number; latency_ms: number; top_file: string | null };
      grep_read: { workflow_full_tokens: number; latency_ms: number; top_file: string | null };
      efficiency: { token_savings_pct: number };
      accuracy: {
        rank1_match: boolean;
        top_k_overlap_pct: number;
        labeled_recall?: { miru: boolean; grep: boolean };
      };
      overhead: { parallel_total_ms: number };
    };
    const probe = entry.tool_response._probe as { tool_wall_ms: number; category: string };

    console.log(`=== ${probe.category}: ${entry.tool_response.query} ===\n`);
    console.log(
      JSON.stringify(
        {
          query: entry.tool_response.query,
          result_count: (entry.tool_response.results as unknown[]).length,
          benchmark: entry.tool_response.benchmark,
          first_hit: (entry.tool_response.results as Array<{ chunk: { file_path: string } }>)[0]
            ?.chunk,
        },
        null,
        2,
      ),
    );
    console.log("");
    console.log("Summary:");
    console.log(
      `  miru workflow: ${b.miru.workflow_tokens} tok / ${b.miru.latency_ms}ms → ${b.miru.top_file}`,
    );
    console.log(
      `  grep+Read:     ${b.grep_read.workflow_full_tokens} tok / ${b.grep_read.latency_ms}ms → ${b.grep_read.top_file}`,
    );
    console.log(`  savings:       ${b.efficiency.token_savings_pct}% fewer tokens vs grep+Read(full)`);
    console.log(
      `  accuracy:      rank1_match=${b.accuracy.rank1_match}  overlap=${b.accuracy.top_k_overlap_pct}%  labeled miru=${b.accuracy.labeled_recall?.miru} grep=${b.accuracy.labeled_recall?.grep}`,
    );
    console.log(
      `  overhead:      parallel=${b.overhead.parallel_total_ms}ms  tool_wall=${probe.tool_wall_ms}ms`,
    );
    console.log("");
  }

  const mean = (pick: (b: (typeof responses)[0]) => number) =>
    responses.reduce((sum, row) => sum + pick(row), 0) / responses.length;

  console.log("=== AGGREGATE (3 queries) ===");
  console.log(`  index (first run):     ${indexMs}ms`);
  console.log(`  miru workflow tokens:  ${mean((r) => (r.tool_response.benchmark as { miru: { workflow_tokens: number } }).miru.workflow_tokens).toFixed(0)} avg`);
  console.log(
    `  grep+Read tokens:      ${mean((r) => (r.tool_response.benchmark as { grep_read: { workflow_full_tokens: number } }).grep_read.workflow_full_tokens).toFixed(0)} avg`,
  );
  console.log(
    `  token savings:         ${mean((r) => (r.tool_response.benchmark as { efficiency: { token_savings_pct: number } }).efficiency.token_savings_pct).toFixed(0)}% avg`,
  );
  console.log(
    `  labeled recall:        miru ${responses.filter((r) => (r.tool_response.benchmark as { accuracy: { labeled_recall?: { miru: boolean } } }).accuracy.labeled_recall?.miru).length}/${responses.length}  grep ${responses.filter((r) => (r.tool_response.benchmark as { accuracy: { labeled_recall?: { grep: boolean } } }).accuracy.labeled_recall?.grep).length}/${responses.length}`,
  );
  console.log(
    `  parallel overhead:     ${mean((r) => (r.tool_response.benchmark as { overhead: { parallel_total_ms: number } }).overhead.parallel_total_ms).toFixed(0)}ms avg`,
  );
}
