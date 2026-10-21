import { expect, test } from "bun:test";
import { resolveAlpha } from "../src/ranking/weighting.ts";

test("resolveAlpha uses separate calibrated defaults for linear fusion and RRF", () => {
  const previous = process.env.MIRU_RANK_FUSION;
  try {
    process.env.MIRU_RANK_FUSION = "linear";
    expect(resolveAlpha("convert XML to URL list", undefined)).toBe(0.4);
    expect(resolveAlpha("parseUrl", undefined)).toBe(0.3);
    expect(resolveAlpha("convert XML to URL list", 0.8)).toBe(0.8);
    expect(resolveAlpha("convert XML to URL list", 0)).toBe(0);
    process.env.MIRU_RANK_FUSION = "rrf";
    expect(resolveAlpha("convert XML to URL list", undefined)).toBe(0.25);
    expect(resolveAlpha("parseUrl", undefined)).toBe(0.3);
  } finally {
    if (previous === undefined) delete process.env.MIRU_RANK_FUSION;
    else process.env.MIRU_RANK_FUSION = previous;
  }
});
