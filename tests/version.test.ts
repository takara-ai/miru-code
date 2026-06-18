import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import { fetchLatestPublishedVersion, isVersionNewer, miruVersion } from "../src/version.ts";

describe("version", () => {
  test("miruVersion matches package.json", () => {
    expect(miruVersion()).toBe(packageJson.version);
  });

  test("isVersionNewer compares semver tuples", () => {
    expect(isVersionNewer("0.7.0", "0.6.1")).toBe(true);
    expect(isVersionNewer("0.6.1", "0.6.1")).toBe(false);
    expect(isVersionNewer("0.6.0", "0.6.1")).toBe(false);
    expect(isVersionNewer("1.0.0", "0.9.9")).toBe(true);
  });

  test("fetchLatestPublishedVersion returns a semver string", async () => {
    const latest = await fetchLatestPublishedVersion();
    expect(latest).toMatch(/^\d+\.\d+\.\d+/);
  }, 10_000);
});
