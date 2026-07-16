import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BertWordPieceTokenizer } from "./tokenizer/bert-wordpiece.ts";
import { loadTokenizerFromFile } from "./tokenizer/load.ts";
import type { SearchResult } from "./types.ts";

const TOKENIZER_JSON_ENV = "MIRU_TOKENIZER_JSON";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_TOKENIZER_JSON = join(PACKAGE_ROOT, "tokenizer", "tokenizer.json");

let cached: BertWordPieceTokenizer | undefined;
let cachedPath: string | null = null;

function resolveTokenizerJsonPath(): string {
  const fromEnv = process.env[TOKENIZER_JSON_ENV]?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return DEFAULT_TOKENIZER_JSON;
}

function loadTokenizer(): BertWordPieceTokenizer {
  if (cached) {
    return cached;
  }

  const path = resolveTokenizerJsonPath();
  if (!existsSync(path)) {
    throw new Error(
      `Tokenizer not found at ${path}. Set ${TOKENIZER_JSON_ENV} or add tokenizer/tokenizer.json to the package.`,
    );
  }

  cached = loadTokenizerFromFile(path);
  cachedPath = path;
  return cached;
}

/** Reset cached tokenizer (for tests). */
export function resetTokenizerCache(): void {
  cached = undefined;
  cachedPath = null;
}

export function tokenizerJsonPath(): string {
  loadTokenizer();
  return cachedPath ?? resolveTokenizerJsonPath();
}

/** @deprecated Use tokenCountMethod() — kept for benchmark response compatibility. */
export function tokenCountMethod(): "wordpiece" {
  return "wordpiece";
}

export function countTokens(text: string): number {
  return loadTokenizer().count(text);
}

export function estimateResultTokens(results: SearchResult[]): number {
  return results.reduce((sum, result) => sum + countTokens(result.chunk.content), 0);
}
