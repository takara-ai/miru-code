import { describe, expect, test } from "bun:test";
import {
  getIndexForRepo,
  IndexCache,
  mcpWatchEnabled,
  shouldIgnoreWatchPath,
} from "../src/mcp/index-cache.ts";

describe("IndexCache", () => {
  test("getIndexForRepo requires repo when no default is configured", async () => {
    const cache = new IndexCache();
    await expect(getIndexForRepo(null, null, cache)).rejects.toThrow(/No repo specified/);
  });

  test("getIndexForRepo rejects unsafe git transport schemes", async () => {
    const cache = new IndexCache();
    await expect(getIndexForRepo("git@github.com:org/repo", null, cache)).rejects.toThrow(
      /Only https:\/\//,
    );
  });

  test("shouldIgnoreWatchPath skips noisy directories", () => {
    expect(shouldIgnoreWatchPath("node_modules/foo/index.js")).toBe(true);
    expect(shouldIgnoreWatchPath(".git/HEAD")).toBe(true);
    expect(shouldIgnoreWatchPath("src/index.ts")).toBe(false);
    expect(shouldIgnoreWatchPath(null)).toBe(false);
  });

  test("mcpWatchEnabled respects MIRU_MCP_WATCH=0", () => {
    const prev = process.env.MIRU_MCP_WATCH;
    process.env.MIRU_MCP_WATCH = "0";
    expect(mcpWatchEnabled()).toBe(false);
    process.env.MIRU_MCP_WATCH = prev;
  });
});
