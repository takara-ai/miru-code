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
      _full_benchmark: comparison.benchmark,
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
      save_pct: number;
      miru_tok: number;
      grep_tok: number;
      saved_tok: number;
      rank1: boolean;
      miru_only?: string[];
    };
    const full = (
      entry.tool_response as {
        _full_benchmark: {
          miru: { workflow_tokens: number; latency_ms: number; top_file: string | null };
          grep_read: {
            workflow_full_tokens: number;
            latency_ms: number;
            top_file: string | null;
          };
          efficiency: { token_savings_pct: number };
          accuracy: {
            rank1_match: boolean;
            top_k_overlap_pct: number;
            labeled_recall?: { miru: boolean; grep: boolean };
          };
          overhead: { parallel_total_ms: number };
        };
      }
    )._full_benchmark;
    const probe = entry.tool_response._probe as { tool_wall_ms: number; category: string };

    console.log(`=== ${probe.category}: ${entry.tool_response.query} ===\n`);
    console.log(
      JSON.stringify(
        {
          query: entry.tool_response.query,
          result_count: (entry.tool_response.results as unknown[]).length,
          benchmark: b,
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
      `  miru workflow: ${full.miru.workflow_tokens} tok / ${full.miru.latency_ms}ms → ${full.miru.top_file}`,
    );
    console.log(
      `  grep+Read:     ${full.grep_read.workflow_full_tokens} tok / ${full.grep_read.latency_ms}ms → ${full.grep_read.top_file}`,
    );
    console.log(
      `  savings:       ${full.efficiency.token_savings_pct}% fewer tokens vs grep+Read(full)`,
    );
    console.log(
      `  accuracy:      rank1_match=${full.accuracy.rank1_match}  overlap=${full.accuracy.top_k_overlap_pct}%  labeled miru=${full.accuracy.labeled_recall?.miru} grep=${full.accuracy.labeled_recall?.grep}`,
    );
    console.log(
      `  overhead:      parallel=${full.overhead.parallel_total_ms}ms  tool_wall=${probe.tool_wall_ms}ms`,
    );
    console.log(`  agent payload: ${JSON.stringify(b)}`);
    console.log("");
  }

  const mean = (pick: (b: (typeof responses)[0]) => number) =>
    responses.reduce((sum, row) => sum + pick(row), 0) / responses.length;

  console.log("=== AGGREGATE (3 queries) ===");
  console.log(`  index (first run):     ${indexMs}ms`);
  console.log(
    `  miru workflow tokens:  ${mean((r) => (r.tool_response.benchmark as { miru_tok: number }).miru_tok).toFixed(0)} avg`,
  );
  console.log(
    `  grep+Read tokens:      ${mean((r) => (r.tool_response.benchmark as { grep_tok: number }).grep_tok).toFixed(0)} avg`,
  );
  console.log(
    `  token savings:         ${mean((r) => (r.tool_response.benchmark as { save_pct: number }).save_pct).toFixed(0)}% avg`,
  );
  console.log(
    `  labeled recall:        miru ${responses.filter((r) => (r.tool_response as { _full_benchmark: { accuracy: { labeled_recall?: { miru: boolean } } } })._full_benchmark.accuracy.labeled_recall?.miru).length}/${responses.length}  grep ${responses.filter((r) => (r.tool_response as { _full_benchmark: { accuracy: { labeled_recall?: { grep: boolean } } } })._full_benchmark.accuracy.labeled_recall?.grep).length}/${responses.length}`,
  );
  console.log(
    `  parallel overhead:     ${mean((r) => (r.tool_response as { _full_benchmark: { overhead: { parallel_total_ms: number } } })._full_benchmark.overhead.parallel_total_ms).toFixed(0)}ms avg`,
  );
}
