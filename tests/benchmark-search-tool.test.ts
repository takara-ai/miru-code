import { afterEach, describe, expect, test } from "bun:test";
import {
  BenchmarkSearchTimeoutError,
  selectBenchmarkSearchTool,
  spawnBenchmarkSearch,
  withGrepTimeoutFallback,
} from "../src/benchmark/grep.ts";
import {
  batchLiteralPaths,
  selectComparableLiteralSearchTool,
} from "../src/benchmark/rg-literal.ts";

afterEach(() => {
  delete process.env.MIRU_BENCHMARK_SEARCH_TIMEOUT;
});

describe("benchmark search tool selection", () => {
  test("batches literal benchmark paths before command-line limits", () => {
    const paths = Array.from({ length: 3 }, (_, i) => `${"a".repeat(2_000)}-${i}.ts`);
    expect(batchLiteralPaths(paths)).toEqual([[paths[0], paths[1]], [paths[2]]]);
  });

  test("literal benchmark selection never returns findstr", () => {
    expect(
      selectComparableLiteralSearchTool({
        platform: "win32",
        hasRg: false,
        hasGrep: false,
        hasFindstr: true,
      }),
    ).toBeNull();
  });

  test("prefers rg when available", () => {
    expect(
      selectBenchmarkSearchTool({
        platform: "linux",
        hasRg: true,
        hasGrep: true,
        hasFindstr: true,
      }),
    ).toBe("rg");
  });

  test("falls back to grep when rg is missing on unix", () => {
    expect(
      selectBenchmarkSearchTool({
        platform: "darwin",
        hasRg: false,
        hasGrep: true,
        hasFindstr: false,
      }),
    ).toBe("grep");
  });

  test("falls back to findstr on windows when rg and grep are missing", () => {
    expect(
      selectBenchmarkSearchTool({
        platform: "win32",
        hasRg: false,
        hasGrep: false,
        hasFindstr: true,
      }),
    ).toBe("findstr");
  });

  test("returns null when no supported tool exists", () => {
    expect(
      selectBenchmarkSearchTool({
        platform: "linux",
        hasRg: false,
        hasGrep: false,
        hasFindstr: false,
      }),
    ).toBeNull();
  });
});

describe("benchmark search timeout", () => {
  const bun = process.execPath;

  test("spawnBenchmarkSearch returns stdout when process finishes in time", async () => {
    process.env.MIRU_BENCHMARK_SEARCH_TIMEOUT = "5";
    expect(await spawnBenchmarkSearch([bun, "-e", "process.stdout.write('ok')"])).toBe("ok");
  });

  test("spawnBenchmarkSearch kills hung processes", async () => {
    process.env.MIRU_BENCHMARK_SEARCH_TIMEOUT = "1";
    const started = performance.now();
    await expect(
      spawnBenchmarkSearch([bun, "-e", "await Bun.sleep(30_000)"]),
    ).rejects.toBeInstanceOf(BenchmarkSearchTimeoutError);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("withGrepTimeoutFallback maps timeout to null", async () => {
    expect(
      await withGrepTimeoutFallback(async () => {
        throw new BenchmarkSearchTimeoutError(1);
      }),
    ).toBeNull();
  });
});
