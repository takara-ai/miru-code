import { describe, expect, test } from "bun:test";
import { getIndexForRepo, IndexCache } from "../src/mcp/index-cache.ts";

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
});
