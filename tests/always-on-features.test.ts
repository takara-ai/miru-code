import { expect, test } from "bun:test";
import {
  ALWAYS_ON_FEATURE_NAMES,
  buildAlwaysOnRankFeatures,
  restoredPrior,
  unicodeRankTerms,
} from "../src/ranking/always-on-features.ts";
import { buildDefinitionFeatures } from "../src/ranking/learned-features.ts";
import { type Chunk, chunkKey } from "../src/types.ts";

test("definition features distinguish declarations from calls and retain symbol boost tiers", () => {
  const definition: Chunk = {
    content: "export class HttpClient {}",
    file_path: "src/HttpClient.ts",
    start_line: 1,
    end_line: 1,
    language: "typescript",
  };
  const call = {
    ...definition,
    content: "const client = new HttpClient();",
    file_path: "src/usage.ts",
  };
  const [direct, usage] = buildDefinitionFeatures("HttpClient", [definition, call]);
  expect(direct).toMatchObject({ coverage: 1, exactSymbol: 1, tier: 1.5 });
  expect(usage).toMatchObject({ coverage: 0, exactSymbol: 0, tier: 0 });
  const [natural] = buildDefinitionFeatures("how HttpClient opens connections", [definition]);
  expect(natural?.tier).toBeGreaterThan(0);
  expect(natural?.exactSymbol).toBe(0);
  definition.content = "HttpClient.open();";
  expect(buildDefinitionFeatures("HttpClient", [definition])[0]?.coverage).toBe(0);
});

test("Unicode overlap recognizes code and comments beyond ASCII and normalizes accents", () => {
  expect(unicodeRankTerms("cafe\u0301 café")).toEqual(["café"]);
  const chunk: Chunk = {
    content: "def обработать(данные):\n    # обработать данные\n    return данные",
    file_path: "src/данные.py",
    start_line: 1,
    end_line: 3,
    language: "python",
  };
  const ranked = [{ chunk, score: 1 }],
    key = chunkKey(chunk);
  const built = buildAlwaysOnRankFeatures(
    "обработать данные",
    new Map([[key, 0.8]]),
    new Map([[key, 0]]),
    ranked,
    ranked,
  );
  const get = (name: (typeof ALWAYS_ON_FEATURE_NAMES)[number]) =>
    built.features[0]?.[ALWAYS_ON_FEATURE_NAMES.indexOf(name)];
  expect(get("unicode_body_coverage")).toBe(1);
  expect(get("non_ascii_letter_fraction")).toBe(1);
  expect(get("unicode_definition_coverage")).toBe(0.5);
  expect(get("boosted_prior")).toBe(3);
  expect(built.features[0]).toHaveLength(60);
  chunk.content = "def unrelated():\n    return None";
  const changed = buildAlwaysOnRankFeatures(
    "обработать данные",
    new Map([[key, 0.8]]),
    new Map([[key, 0]]),
    ranked,
    ranked,
  );
  expect(changed.features[0]?.[ALWAYS_ON_FEATURE_NAMES.indexOf("unicode_body_coverage")]).toBe(0);
});

test("the model sees the original boosted prior before file saturation", () => {
  const first: Chunk = {
    content: "function parse() {}",
    file_path: "a.ts",
    start_line: 1,
    end_line: 1,
    language: "typescript",
  };
  const duplicate = { ...first, start_line: 3, end_line: 3 },
    second = { ...first, file_path: "b.ts" };
  const prior = restoredPrior([
    { chunk: first, score: 1 },
    { chunk: second, score: 0.8 },
    { chunk: duplicate, score: 0.45 },
  ]);
  expect(prior.get(chunkKey(first))).toBe(3);
  expect(prior.get(chunkKey(second))).toBe(Math.fround(2.4));
  expect(prior.get(chunkKey(duplicate))).toBe(Math.fround(2.7));
});
