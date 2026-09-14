/**
 * Compare agent-facing token cost + latency for exact literal lookup:
 *   - Miru `locate` (count / locations / lines) over the warm index
 *   - corpus- and mode-aligned fixed-string ripgrep (`rg -F`)
 *   - Miru hybrid `search` (wrong tool for literals — control)
 *
 * Usage:
 *   bun run scripts/benchmark-literal-tokens.ts
 *   bun run scripts/benchmark-literal-tokens.ts -- --json
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkLocateComparison } from "../src/benchmark/locate-compare.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import type { LiteralMode } from "../src/literal.ts";
import { formatResultsText } from "../src/mcp/format-text.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { countTokens } from "../src/token-count.ts";
import { dedupeResultsByFile, formatResults } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonOnly = process.argv.includes("--json");

const LITERALS = [
  "MIRU_BENCHMARK_HISTORY_PATH",
  "MCP_BENCHMARK_FLAG",
  "locateLiteral",
  "read_benchmark",
  "WordPiece",
] as const;

type ToolRow = {
  tool: string;
  tokens: number;
  ms: number;
  n: number;
  files: number;
};

function mean(rows: number[]): number {
  if (rows.length === 0) {
    return 0;
  }
  return rows.reduce((a, b) => a + b, 0) / rows.length;
}

console.error(`Loading index (${REPO_ROOT})...`);
const indexStart = performance.now();
const index = await MiruIndex.fromPath(REPO_ROOT);
const indexMs = performance.now() - indexStart;
console.error(`Index ready in ${indexMs.toFixed(0)}ms (${index.chunks.length} chunks)\n`);

const byLiteral: Array<{
  literal: string;
  tools: ToolRow[];
  parity: Array<{
    mode: LiteralMode;
    miru: { n: number; files: number };
    grep: { n: number; files: number };
  }>;
}> = [];

for (const literal of LITERALS) {
  const tools: ToolRow[] = [];
  const parity: Array<{
    mode: LiteralMode;
    miru: { n: number; files: number };
    grep: { n: number; files: number };
  }> = [];

  for (const mode of ["count", "locations", "lines"] as LiteralMode[]) {
    const comparison = await benchmarkLocateComparison({
      literal,
      repoPath: REPO_ROOT,
      index,
      locate: { mode, limit: 20 },
    });
    tools.push({
      tool: `miru locate --mode ${mode}`,
      tokens: comparison.benchmark.miru_tok,
      ms: comparison.latency_ms.miru,
      n: comparison.result.n,
      files: comparison.result.files,
    });
    tools.push({
      tool: `rg -F comparable --mode ${mode}`,
      tokens: comparison.benchmark.grep_tok,
      ms: comparison.latency_ms.grep,
      n: comparison.grep.n,
      files: comparison.grep.files,
    });
    parity.push({
      mode,
      miru: { n: comparison.result.n, files: comparison.result.files },
      grep: comparison.grep,
    });
  }

  const searchStart = performance.now();
  let results = await index.search({ query: literal, topK: 3, rerank: true });
  results = dedupeResultsByFile(results).slice(0, 3);
  const searchMs = performance.now() - searchStart;
  const mcpSearchPayload = formatResultsText(
    formatResults(literal, results, { repoRoot: REPO_ROOT, snippet: true }),
  );
  tools.push({
    tool: "miru search (hybrid, MCP snippets)",
    tokens: countTokens(mcpSearchPayload),
    ms: searchMs,
    n: results.length,
    files: new Set(results.map((r) => r.chunk.file_path)).size,
  });

  byLiteral.push({ literal, tools, parity });
}

if (jsonOnly) {
  console.log(
    JSON.stringify({ index_ms: indexMs, chunks: index.chunks.length, byLiteral }, null, 2),
  );
  process.exit(0);
}

for (const row of byLiteral) {
  console.log(`=== ${row.literal} ===`);
  for (const tool of row.tools) {
    console.log(
      `  ${tool.tool.padEnd(40)} ${String(tool.tokens).padStart(5)} tok  ${tool.ms.toFixed(1).padStart(7)}ms  n=${tool.n} files=${tool.files}`,
    );
  }
  console.log("");
}

const toolNames = byLiteral[0]?.tools.map((t) => t.tool) ?? [];
console.log("=== AGGREGATE (mean over literals) ===");
console.log(`  index (first load): ${indexMs.toFixed(0)}ms`);
for (const name of toolNames) {
  const tokens = byLiteral.map((r) => r.tools.find((t) => t.tool === name)?.tokens ?? 0);
  const ms = byLiteral.map((r) => r.tools.find((t) => t.tool === name)?.ms ?? 0);
  console.log(
    `  ${name.padEnd(40)} ${mean(tokens).toFixed(0).padStart(5)} tok  ${mean(ms).toFixed(1).padStart(7)}ms`,
  );
}
