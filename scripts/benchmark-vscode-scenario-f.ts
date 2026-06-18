/**
 * Scenario F from DS1 Miru Benchmark Report: deprecated API noise vs precision.
 *
 * 1. Grep word-boundary counts (replicates broad literal scanner)
 * 2. Miru search AST vs structural on the same VS Code checkout
 *
 * Usage:
 *   bun run scripts/benchmark-vscode-scenario-f.ts
 *   VSCODE_BENCH_ROOT=~/.cache/miru-bench/vscode bun run scripts/benchmark-vscode-scenario-f.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import type { SearchResult } from "../src/types.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const VSCODE_ROOT = process.env.VSCODE_BENCH_ROOT ?? join(process.env.HOME ?? "", ".cache/miru-bench/vscode");
const CALLSITE_DIRS = ["src/vs/editor", "src/vs/workbench", "src/vs/platform"] as const;
const DEFINITION_DIR = "src/vs/editor";
const TOP_K = 50;

/** Symbols called out in the benchmark report as noise-inflated. */
const NOISY_SYMBOLS = ["changes", "before", "after", "browserEvent"] as const;

interface DeprecatedSymbol {
  name: string;
  file: string;
  line: number;
  kind: "property" | "method" | "unknown";
}

async function extractDeprecatedSymbols(editorRoot: string): Promise<DeprecatedSymbol[]> {
  const symbols: DeprecatedSymbol[] = [];
  const proc = Bun.spawn(["rg", "-l", "@deprecated", editorRoot, "--glob", "*.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const files = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
  await proc.exited;

  for (const absPath of files) {
    const rel = absPath.replace(`${VSCODE_ROOT}/`, "");
    const lines = readFileSync(absPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.includes("@deprecated")) {
        continue;
      }
      // Look at the next few lines for a declaration.
      const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
      const prop = window.match(/\n\s+(\w+)\s*[:?]/);
      const method = window.match(/\n\s+(\w+)\s*\(/);
      const name = prop?.[1] ?? method?.[1];
      if (!name) {
        continue;
      }
      symbols.push({
        name,
        file: rel,
        line: i + 1,
        kind: prop ? "property" : method ? "method" : "unknown",
      });
    }
  }

  const byName = new Map<string, DeprecatedSymbol>();
  for (const s of symbols) {
    if (!byName.has(s.name)) {
      byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

async function grepWordCount(symbol: string): Promise<number> {
  const args = [
    "rg",
    "-w",
    symbol,
    ...CALLSITE_DIRS.map((d) => join(VSCODE_ROOT, d)),
    "--glob",
    "*.ts",
    "--glob",
    "!*.test.ts",
    "--glob",
    "!*.spec.ts",
    "--glob",
    "!*.d.ts",
    "-c",
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  let total = 0;
  for (const line of text.split("\n")) {
    const colon = line.lastIndexOf(":");
    if (colon < 0) {
      continue;
    }
    const n = Number(line.slice(colon + 1));
    if (Number.isFinite(n)) {
      total += n;
    }
  }
  return total;
}

function classifyHit(symbol: string, result: SearchResult, definitionFiles: Set<string>): "true_usage" | "noise" {
  const content = result.chunk.content;
  const file = result.chunk.file_path;

  // Definition site of the deprecated symbol.
  if (definitionFiles.has(file) && content.includes("@deprecated")) {
    return "true_usage";
  }

  // Property access or method call patterns.
  const accessPatterns = [
    new RegExp(`\\.${symbol}\\b`),
    new RegExp(`\\['${symbol}'\\]`),
    new RegExp(`\\["${symbol}"\\]`),
    new RegExp(`\\b${symbol}\\s*\\(`),
    new RegExp(`:\\s*${symbol}\\b`),
    new RegExp(`\\b${symbol}\\s*:`),
  ];
  if (accessPatterns.some((p) => p.test(content))) {
    return "true_usage";
  }

  // Bare word / unrelated context.
  if (new RegExp(`\\b${symbol}\\b`).test(content)) {
    return "noise";
  }
  return "noise";
}

async function miruSearchArm(
  indexRoot: string,
  ast: boolean,
  symbols: DeprecatedSymbol[],
): Promise<{
  chunks: number;
  indexMs: number;
  bySymbol: Record<
    string,
    {
      hits: number;
      trueUsage: number;
      noise: number;
      topFiles: string[];
    }
  >;
}> {
  process.env.MIRU_AST_CHUNKING = ast ? "1" : "0";
  process.env.MIRU_SEARCH_V2 = "1";
  await clearCache(indexRoot);

  const started = performance.now();
  const index = await MiruIndex.fromPath(indexRoot, ["code"]);
  const indexMs = performance.now() - started;

  const defFiles = new Set(symbols.map((s) => s.file));
  const bySymbol: Record<string, { hits: number; trueUsage: number; noise: number; topFiles: string[] }> =
    {};

  for (const sym of NOISY_SYMBOLS) {
    const def = symbols.find((s) => s.name === sym);
    const query = def
      ? `deprecated ${sym} ${def.kind} usage callsite editor`
      : `deprecated ${sym} property access editor`;

    const results = await index.search({ query, topK: TOP_K, rerank: true });
    let trueUsage = 0;
    let noise = 0;
    for (const r of results) {
      const kind = classifyHit(sym, r, defFiles);
      if (kind === "true_usage") {
        trueUsage++;
      } else {
        noise++;
      }
    }
    bySymbol[sym] = {
      hits: results.length,
      trueUsage,
      noise,
      topFiles: results.slice(0, 5).map((r) => r.chunk.file_path),
    };
  }

  return { chunks: index.chunks.length, indexMs, bySymbol };
}

// --- main ---
console.error(`VS Code root: ${VSCODE_ROOT}`);
const editorRoot = join(VSCODE_ROOT, DEFINITION_DIR);
const deprecated = await extractDeprecatedSymbols(editorRoot);

console.error(`\n=== Deprecated symbols in ${DEFINITION_DIR} (${deprecated.length} unique) ===`);
for (const s of deprecated.slice(0, 15)) {
  console.error(`  ${s.name} (${s.kind}) @ ${s.file}:${s.line}`);
}
if (deprecated.length > 15) {
  console.error(`  ... and ${deprecated.length - 15} more`);
}

console.error("\n=== Grep word-boundary counts (broad scanner / Scenario F inflation) ===");
const grepCounts: Record<string, number> = {};
let grepTotal = 0;
for (const sym of NOISY_SYMBOLS) {
  const n = await grepWordCount(sym);
  grepCounts[sym] = n;
  grepTotal += n;
  console.error(`  ${sym}: ${n}`);
}
console.error(`  TOTAL (4 symbols): ${grepTotal}`);
console.error(`  PDF reported ~2475 miru-scanner hits; grep-only arm ~70 (precise)`);

const indexRoot = VSCODE_ROOT;
console.error(`\n=== Indexing ${CALLSITE_DIRS.join(", ")} ===`);
console.error("(This may take several minutes — embedding all callsite files)\n");

const structural = await miruSearchArm(indexRoot, false, deprecated);
console.error(
  `Structural: ${structural.chunks} chunks, indexed in ${(structural.indexMs / 1000).toFixed(1)}s`,
);
const ast = await miruSearchArm(indexRoot, true, deprecated);
console.error(`AST:        ${ast.chunks} chunks, indexed in ${(ast.indexMs / 1000).toFixed(1)}s`);

console.error("\n=== Miru search top_k=" + TOP_K + " (semantic retrieval, not exhaustive scan) ===");
console.error("symbol          grep    struct(true/noise)  ast(true/noise)");
for (const sym of NOISY_SYMBOLS) {
  const s = structural.bySymbol[sym];
  const a = ast.bySymbol[sym];
  console.error(
    `${sym.padEnd(14)}  ${String(grepCounts[sym]).padStart(5)}  ` +
      `${String(s?.trueUsage ?? 0).padStart(4)}/${String(s?.noise ?? 0).padStart(4)}              ` +
      `${String(a?.trueUsage ?? 0).padStart(4)}/${String(a?.noise ?? 0).padStart(4)}`,
  );
}

const structNoise = NOISY_SYMBOLS.reduce((n, sym) => n + (structural.bySymbol[sym]?.noise ?? 0), 0);
const astNoise = NOISY_SYMBOLS.reduce((n, sym) => n + (ast.bySymbol[sym]?.noise ?? 0), 0);
const structTrue = NOISY_SYMBOLS.reduce((n, sym) => n + (structural.bySymbol[sym]?.trueUsage ?? 0), 0);
const astTrue = NOISY_SYMBOLS.reduce((n, sym) => n + (ast.bySymbol[sym]?.trueUsage ?? 0), 0);

console.error("\n=== Interpretation ===");
console.error(
  `Grep literal scan: ${grepTotal} word-boundary matches — same failure mode as PDF Scenario F scanner.`,
);
console.error(
  `Miru search (either chunker): ${structTrue + structNoise} max results across 4 queries — NOT a 2475-hit enumeration.`,
);
console.error(
  `Noise in top-${TOP_K} results: structural=${structNoise}, ast=${astNoise} (lower is better)`,
);
console.error(
  astNoise <= structNoise
    ? "AST did not increase search noise vs structural."
    : "AST increased search noise vs structural.",
);

console.log(
  JSON.stringify({
    vscode_root: VSCODE_ROOT,
    deprecated_symbol_count: deprecated.length,
    grep_word_counts: grepCounts,
    grep_total_noisy_four: grepTotal,
    pdf_reference: { miru_scanner_hits: 2475, grep_precise_hits: 70 },
    structural: { chunks: structural.chunks, index_ms: structural.indexMs, by_symbol: structural.bySymbol },
    ast: { chunks: ast.chunks, index_ms: ast.indexMs, by_symbol: ast.bySymbol },
    miru_noise_top_k: { structural: structNoise, ast: astNoise },
    miru_true_usage_top_k: { structural: structTrue, ast: astTrue },
  }),
);
