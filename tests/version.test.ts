import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import {
  fetchLatestPublishedVersion,
  indexCacheEpoch,
  isVersionNewer,
  maybeNotifyUpdate,
  miruVersion,
} from "../src/version.ts";

let tempDir: string | undefined;
const oldCacheHome = process.env.MIRU_CACHE_HOME;
const oldNoUpdate = process.env.MIRU_NO_UPDATE_CHECK;
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  if (oldCacheHome === undefined) delete process.env.MIRU_CACHE_HOME;
  else process.env.MIRU_CACHE_HOME = oldCacheHome;
  if (oldNoUpdate === undefined) delete process.env.MIRU_NO_UPDATE_CHECK;
  else process.env.MIRU_NO_UPDATE_CHECK = oldNoUpdate;
});

describe("version", () => {
  test("miruVersion matches package.json", () => {
    expect(miruVersion()).toBe(packageJson.version);
    expect(indexCacheEpoch()).toBe(packageJson.version.split(".")[0]);
    expect(indexCacheEpoch("0.8.4")).toBe("0.8");
  });

  test("isVersionNewer compares semver tuples", () => {
    expect(isVersionNewer("0.7.0", "0.6.1")).toBe(true);
    expect(isVersionNewer("0.6.1", "0.6.1")).toBe(false);
    expect(isVersionNewer("0.6.0", "0.6.1")).toBe(false);
    expect(isVersionNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isVersionNewer("1.2.0", "1.1.99")).toBe(true);
    expect(isVersionNewer("1.2.0", "1.2.1")).toBe(false);
    expect(isVersionNewer("1.2.2", "1.2.1")).toBe(true);
    expect(isVersionNewer("1.1.9", "1.2.0")).toBe(false);
    expect(isVersionNewer("0.9.9", "1.0.0")).toBe(false);
    expect(isVersionNewer("latest", "latest")).toBe(false);
    expect(isVersionNewer("latest", "invalid")).toBe(true);
  });

  test("fetchLatestPublishedVersion returns a semver string", async () => {
    const fetchLatest = (_input: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ "dist-tags": { latest: "1.8.0" } }), { status: 200 }),
      );
    const latest = await fetchLatestPublishedVersion(fetchLatest);
    expect(latest).toMatch(/^\d+\.\d+\.\d+/);
  }, 10_000);

  test("fetchLatestPublishedVersion rejects bad responses", async () => {
    await expect(
      fetchLatestPublishedVersion(async () => new Response("", { status: 503 })),
    ).rejects.toThrow("registry 503");
    await expect(fetchLatestPublishedVersion(async () => new Response("{}"))).rejects.toThrow(
      "missing dist-tags.latest",
    );
  });

  test("maybeNotifyUpdate honors the opt-out and caches registry results", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "miru-version-"));
    process.env.MIRU_CACHE_HOME = tempDir;
    const write = spyOn(process.stderr, "write").mockImplementation(
      (() => true) as typeof process.stderr.write,
    );
    const fetcher = async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }));
    try {
      process.env.MIRU_NO_UPDATE_CHECK = "1";
      await maybeNotifyUpdate(fetcher);
      expect(write).not.toHaveBeenCalled();

      delete process.env.MIRU_NO_UPDATE_CHECK;
      await maybeNotifyUpdate(fetcher);
      expect(write).toHaveBeenCalled();
      write.mockClear();
      await maybeNotifyUpdate(async () => {
        throw new Error("should use fresh cache");
      });
      expect(write).toHaveBeenCalled();

      write.mockClear();
      await writeFile(
        join(tempDir, "update-check.json"),
        JSON.stringify({ checkedAt: 0, latest: "1.0.0" }),
      );
      await maybeNotifyUpdate(
        async () => new Response(JSON.stringify({ "dist-tags": { latest: miruVersion() } })),
      );
      expect(await Bun.file(join(tempDir, "update-check.json")).exists()).toBe(true);
      expect(write).not.toHaveBeenCalled();

      write.mockClear();
      await writeFile(join(tempDir, "update-check.json"), "invalid json");
      await maybeNotifyUpdate(async () => {
        throw new Error("offline");
      });
      expect(write).not.toHaveBeenCalled();

      await writeFile(join(tempDir, "update-check.json"), "{}");
      await maybeNotifyUpdate(async () => {
        throw new Error("offline");
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
