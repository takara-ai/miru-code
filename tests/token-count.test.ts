import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countTokens,
  resetTokenizerCache,
  tokenCountMethod,
  tokenizerJsonPath,
} from "../src/token-count.ts";

const ENV_JSON = "MIRU_TOKENIZER_JSON";
const ENV_CONFIG = "MIRU_TOKENIZER_CONFIG";

afterEach(() => {
  delete process.env[ENV_JSON];
  delete process.env[ENV_CONFIG];
  resetTokenizerCache();
});

describe("token-count", () => {
  test("uses bundled tokenizer by default", () => {
    expect(tokenCountMethod()).toBe("huggingface");
    expect(tokenizerJsonPath()).toContain("tokenizer/tokenizer.json");
    expect(countTokens("export async function main() {}")).toBeGreaterThan(0);
  });

  test("loads tokenizer from MIRU_TOKENIZER_JSON", async () => {
    const modelId = "gpt2";
    const tokenizerJson = await fetch(
      `https://huggingface.co/${modelId}/resolve/main/tokenizer.json`,
    ).then((res) => res.text());
    const tokenizerConfig = await fetch(
      `https://huggingface.co/${modelId}/resolve/main/tokenizer_config.json`,
    ).then((res) => res.text());

    const dir = mkdtempSync(join(tmpdir(), "miru-tokenizer-"));
    const jsonPath = join(dir, "tokenizer.json");
    const configPath = join(dir, "tokenizer_config.json");
    writeFileSync(jsonPath, tokenizerJson);
    writeFileSync(configPath, tokenizerConfig);
    process.env[ENV_JSON] = jsonPath;
    resetTokenizerCache();

    expect(tokenizerJsonPath()).toBe(jsonPath);
    const text = "export async function hybridSearchRanking() { return 42; }";
    expect(countTokens(text)).toBeGreaterThan(0);
  });

  test("throws when tokenizer json is missing", () => {
    process.env[ENV_JSON] = join(tmpdir(), "missing-tokenizer.json");
    resetTokenizerCache();
    expect(() => countTokens("hello")).toThrow(/Tokenizer not found/);
  });
});
