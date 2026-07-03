import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";
import type { SearchResult } from "./types.ts";

const TOKENIZER_JSON_ENV = "MIRU_TOKENIZER_JSON";
const TOKENIZER_CONFIG_ENV = "MIRU_TOKENIZER_CONFIG";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_TOKENIZER_JSON = join(PACKAGE_ROOT, "tokenizer", "tokenizer.json");

let cached: Tokenizer | undefined;
let cachedPath: string | null = null;

function resolveTokenizerJsonPath(): string {
  const fromEnv = process.env[TOKENIZER_JSON_ENV]?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return DEFAULT_TOKENIZER_JSON;
}

function resolveTokenizerConfigPath(tokenizerJsonPath: string): string | null {
  const fromEnv = process.env[TOKENIZER_CONFIG_ENV]?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const sibling = join(dirname(tokenizerJsonPath), "tokenizer_config.json");
  if (existsSync(sibling)) {
    return sibling;
  }
  return null;
}

function loadTokenizer(): Tokenizer {
  if (cached) {
    return cached;
  }

  const path = resolveTokenizerJsonPath();
  if (!existsSync(path)) {
    throw new Error(
      `Tokenizer not found at ${path}. Set ${TOKENIZER_JSON_ENV} or add tokenizer/tokenizer.json to the package.`,
    );
  }

  const tokenizerJson = JSON.parse(readFileSync(path, "utf-8")) as object;
  const configPath = resolveTokenizerConfigPath(path);
  const tokenizerConfig = configPath
    ? (JSON.parse(readFileSync(configPath, "utf-8")) as object)
    : {};

  cached = new Tokenizer(tokenizerJson, tokenizerConfig);
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

export function tokenCountMethod(): "huggingface" {
  return "huggingface";
}

export function countTokens(text: string): number {
  return loadTokenizer().encode(text).ids.length;
}

export function estimateResultTokens(results: SearchResult[]): number {
  return results.reduce((sum, result) => sum + countTokens(result.chunk.content), 0);
}
