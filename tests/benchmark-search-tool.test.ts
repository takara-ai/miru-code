import { describe, expect, test } from "bun:test";
import { selectBenchmarkSearchTool } from "../src/benchmark/grep.ts";

describe("benchmark search tool selection", () => {
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
