/**
 * Compare agent-facing token cost + latency for exact literal lookup:
 *   - Miru `locate` (count / locations / lines) over the warm index
 *   - ripgrep fixed-string (`rg -F`) slim vs typical agent Grep (`-C 2`)
 *   - Miru hybrid `search` (wrong tool for literals — control)
 *
 * Usage:
 *   bun run scripts/benchmark-literal-tokens.ts
 *   bun run scripts/benchmark-literal-tokens.ts -- --json
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GREP_CONTEXT } from "../src/benchmark/grep.ts";
import { rgLiteralOutput } from "../src/benchmark/rg-literal.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { formatLiteralLocate, type LiteralMode } from "../src/literal.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { countTokens } from "../src/token-count.ts";
import { dedupeResultsByFile, formatResults } from "../src/utils.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
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

const byLiteral: Array<{ literal: string; tools: ToolRow[] }> = [];

for (const literal of LITERALS) {
  const tools: ToolRow[] = [];

  for (const mode of ["count", "locations", "lines"] as LiteralMode[]) {
    const start = performance.now();
    const result = index.locateLiteral(literal, { mode, limit: 20 });
    const ms = performance.now() - start;
    const payload = JSON.stringify(formatLiteralLocate(result));
    tools.push({
      tool: `miru locate --mode ${mode}`,
      tokens: countTokens(payload),
      ms,
      n: result.n,
      files: result.files,
    });
  }

  const rgSlim = await rgLiteralOutput(REPO_ROOT, literal, { context: 0, maxCount: 20 });
  tools.push({
    tool: "rg -F -n -m 20 (slim)",
    tokens: rgSlim.tokens,
    ms: rgSlim.latency_ms,
    n: rgSlim.n,
    files: rgSlim.files,
  });

  const rgAgent = await rgLiteralOutput(REPO_ROOT, literal, {
    context: GREP_CONTEXT,
    maxCount: 3,
  });
  tools.push({
    tool: `rg -F -n -C ${GREP_CONTEXT} -m 3 (agent Grep-like)`,
    tokens: rgAgent.tokens,
    ms: rgAgent.latency_ms,
    n: rgAgent.n,
    files: rgAgent.files,
  });

  const searchStart = performance.now();
  let results = await index.search({ query: literal, topK: 3, rerank: true });
  results = dedupeResultsByFile(results).slice(0, 3);
  const searchMs = performance.now() - searchStart;
  const mcpSearchPayload = JSON.stringify(
    formatResults(literal, results, { repoRoot: REPO_ROOT, snippet: true }),
  );
  tools.push({
    tool: "miru search (hybrid, MCP snippets)",
    tokens: countTokens(mcpSearchPayload),
    ms: searchMs,
    n: results.length,
    files: new Set(results.map((r) => r.chunk.file_path)).size,
  });

  byLiteral.push({ literal, tools });
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
