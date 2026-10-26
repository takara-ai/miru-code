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

test("ranking alpha override supports calibrated weights without replacing defaults", () => {
  const previous = process.env.MIRU_RANK_ALPHA;
  const fusion = process.env.MIRU_RANK_FUSION;
  try {
    process.env.MIRU_RANK_FUSION = "linear";
    process.env.MIRU_RANK_ALPHA = "0.65";
    expect(resolveAlpha("convert XML to URL list", undefined)).toBe(0.65);
    expect(resolveAlpha("parseUrl", undefined)).toBe(0.65);
    expect(resolveAlpha("parseUrl", 0.2)).toBe(0.2);
    for (const value of ["0", "1"]) {
      process.env.MIRU_RANK_ALPHA = value;
      expect(resolveAlpha("parseUrl", undefined)).toBe(Number(value));
    }
    for (const value of ["", " ", "NaN", "Infinity", "-0.1", "1.1", "0.5oops"]) {
      process.env.MIRU_RANK_ALPHA = value;
      expect(resolveAlpha("convert XML to URL list", undefined)).toBe(0.4);
      expect(resolveAlpha("parseUrl", undefined)).toBe(0.3);
    }
  } finally {
    if (previous === undefined) delete process.env.MIRU_RANK_ALPHA;
    else process.env.MIRU_RANK_ALPHA = previous;
    if (fusion === undefined) delete process.env.MIRU_RANK_FUSION;
    else process.env.MIRU_RANK_FUSION = fusion;
  }
});
