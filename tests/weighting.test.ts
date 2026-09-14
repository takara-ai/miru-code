import { expect, test } from "bun:test";
import { resolveAlpha } from "../src/ranking/weighting.ts";

test("resolveAlpha uses the calibrated lexical-leaning default for natural-language code queries", () => {
  expect(resolveAlpha("convert XML to URL list", undefined)).toBe(0.25);
  expect(resolveAlpha("parseUrl", undefined)).toBe(0.3);
  expect(resolveAlpha("convert XML to URL list", 0.8)).toBe(0.8);
});
