import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countTokens,
  resetTokenizerCache,
  tokenCountMethod,
  tokenizerJsonPath,
} from "../src/token-count.ts";
import { createBertWordPieceTokenizer } from "../src/tokenizer/bert-wordpiece.ts";
import { loadTokenizerFromFile } from "../src/tokenizer/load.ts";

const ENV_JSON = "MIRU_TOKENIZER_JSON";
const BUNDLED = join(import.meta.dir, "..", "tokenizer", "tokenizer.json");

const PARITY_SAMPLES = [
  "export async function hybridSearch() {}",
  "Hello world",
  "export async function main() {}",
  "  semanticIndex: SemanticIndex,",
  'import { printBrandBanner } from "./brand-banner.ts";',
  "async function main(): Promise<void> {",
  "CLI entry point main command line interface",
];

afterEach(() => {
  delete process.env[ENV_JSON];
  resetTokenizerCache();
});

describe("token-count", () => {
  test("uses bundled tokenizer by default", () => {
    expect(tokenCountMethod()).toBe("wordpiece");
    expect(tokenizerJsonPath()).toContain("tokenizer/tokenizer.json");
    expect(countTokens("export async function main() {}")).toBe(8);
  });

  test("loads tokenizer from MIRU_TOKENIZER_JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "miru-tokenizer-"));
    const jsonPath = join(dir, "tokenizer.json");
    copyFileSync(BUNDLED, jsonPath);
    process.env[ENV_JSON] = jsonPath;
    resetTokenizerCache();

    expect(tokenizerJsonPath()).toBe(jsonPath);
    expect(countTokens("export async function main() {}")).toBe(8);
  });

  test("throws when tokenizer json is missing", () => {
    process.env[ENV_JSON] = join(tmpdir(), "missing-tokenizer.json");
    resetTokenizerCache();
    expect(() => countTokens("hello")).toThrow(/Tokenizer not found/);
  });

  test("matches bundled WordPiece reference vectors", () => {
    const tokenizer = loadTokenizerFromFile(BUNDLED);
    const expected: Record<string, number> = {
      "export async function hybridSearch() {}": 10,
      "Hello world": 2,
      "export async function main() {}": 8,
      "  semanticIndex: SemanticIndex,": 8,
      'import { printBrandBanner } from "./brand-banner.ts";': 18,
      "async function main(): Promise<void> {": 11,
      "CLI entry point main command line interface": 7,
    };

    for (const sample of PARITY_SAMPLES) {
      expect(tokenizer.count(sample)).toBe(expected[sample]);
    }
  });

  test("createBertWordPieceTokenizer accepts parsed json", () => {
    const tokenizer = createBertWordPieceTokenizer(
      JSON.parse(readFileSync(BUNDLED, "utf-8")) as Parameters<
        typeof createBertWordPieceTokenizer
      >[0],
    );
    expect(tokenizer.encode("Hello world")).toEqual(["hello", "world"]);
    expect(tokenizer.encode("#!/usr/bin/env bun\nimport { x }")).toContain("import");
  });
});
