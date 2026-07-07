/**
 * A/B parity check: native WordPiece vs @huggingface/tokenizers on the same JSON.
 *
 * Usage:
 *   bun run scripts/tokenizer-ab.ts
 *   bun run scripts/tokenizer-ab.ts -- --json
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tokenizer as HfTokenizer } from "@huggingface/tokenizers";
import { countTokens, resetTokenizerCache } from "../src/token-count.ts";
import { createBertWordPieceTokenizer } from "../src/tokenizer/bert-wordpiece.ts";
import { loadTokenizerFromFile } from "../src/tokenizer/load.ts";
import { applySnippetsToResults } from "../src/snippet.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const jsonFlag = process.argv.includes("--json");
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOKENIZER_JSON = resolve(REPO_ROOT, "tokenizer", "tokenizer.json");

const FIXED_SAMPLES = [
  "export async function hybridSearch() {}",
  "Hello world",
  "export async function main() {}",
  "  semanticIndex: SemanticIndex,",
  'import { printBrandBanner } from "./brand-banner.ts";',
  "async function main(): Promise<void> {",
  "CLI entry point main command line interface",
  "",
  "a",
  "function foo_bar_baz() { return 42; }",
  "// comment with unicode café naïve résumé",
  "path/to/file.ts:42:someIdentifier",
  "SELECT * FROM users WHERE id = $1",
  '{"key": "value", "nested": {"arr": [1, 2, 3]}}',
  "北京 hello 世界",
  "x".repeat(120),
];

const BENCH_QUERIES = [
  "CLI entry point main command line interface",
  "hybrid search ranking BM25 embedding score fusion",
  "where is cli-ui terminal output formatting",
];

interface AbRow {
  label: string;
  text_preview: string;
  native_count: number;
  hf_count: number;
  native_tokens: string[];
  hf_tokens: string[];
  match: boolean;
}

function preview(text: string, max = 56): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

function loadHfTokenizer(): HfTokenizer {
  const json = JSON.parse(readFileSync(TOKENIZER_JSON, "utf-8")) as object;
  return new HfTokenizer(json, {});
}

function compare(label: string, text: string, native: ReturnType<typeof createBertWordPieceTokenizer>, hf: HfTokenizer): AbRow {
  const nativeTokens = native.encode(text);
  const hfEncoded = hf.encode(text);
  const hfTokens = hfEncoded.tokens ?? [];
  const nativeCount = nativeTokens.length;
  const hfCount = hfEncoded.ids.length;
  const match = nativeCount === hfCount && nativeTokens.every((t, i) => t === hfTokens[i]);

  return {
    label,
    text_preview: preview(text),
    native_count: nativeCount,
    hf_count: hfCount,
    native_tokens: nativeTokens,
    hf_tokens: hfTokens,
    match,
  };
}

resetTokenizerCache();
const native = loadTokenizerFromFile(TOKENIZER_JSON);
const hf = loadHfTokenizer();
const rows: AbRow[] = [];

for (const text of FIXED_SAMPLES) {
  rows.push(compare("fixed", text, native, hf));
}

for (const query of BENCH_QUERIES) {
  rows.push(compare("query", query, native, hf));
  if (countTokens(query) !== native.count(query)) {
    throw new Error("countTokens() diverged from native tokenizer");
  }
}

console.error(`Loading index for snippet samples (${REPO_ROOT})...`);
const index = await MiruIndex.fromPath(REPO_ROOT, ["code"]);
for (const query of BENCH_QUERIES) {
  const results = dedupeResultsByFile(await index.search({ query, topK: 5, rerank: true })).slice(0, 5);
  const snippets = applySnippetsToResults(results, query);
  for (const [i, entry] of snippets.entries()) {
    const content = entry.result.chunk.content;
    rows.push(compare(`snippet:${query.slice(0, 24)}#${i + 1}`, content, native, hf));
  }
}

const mismatches = rows.filter((r) => !r.match);
const summary = {
  tokenizer_json: TOKENIZER_JSON,
  sample_count: rows.length,
  matched: rows.length - mismatches.length,
  mismatched: mismatches.length,
  parity: mismatches.length === 0,
  mismatches: mismatches.map((r) => ({
    label: r.label,
    text_preview: r.text_preview,
    native_count: r.native_count,
    hf_count: r.hf_count,
    native_tokens: r.native_tokens,
    hf_tokens: r.hf_tokens,
  })),
};

if (jsonFlag) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  console.log("");
  console.log("=== TOKENIZER A/B: native WordPiece vs @huggingface/tokenizers ===");
  console.log(`file: ${TOKENIZER_JSON}`);
  console.log(`samples: ${rows.length}  matched: ${summary.matched}  mismatched: ${summary.mismatched}`);
  console.log("");

  if (mismatches.length === 0) {
    console.log("PASS — token counts and token sequences match on every sample.");
  } else {
    console.log("FAIL — mismatches:");
    for (const row of mismatches) {
      console.log("");
      console.log(`[${row.label}] ${row.text_preview}`);
      console.log(`  native (${row.native_count}): ${JSON.stringify(row.native_tokens)}`);
      console.log(`  hf     (${row.hf_count}): ${JSON.stringify(row.hf_tokens)}`);
    }
  }
}

process.exit(mismatches.length === 0 ? 0 : 1);
