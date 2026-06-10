import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRootEntryChunks } from "../src/index/entry-chunks.ts";

describe("loadRootEntryChunks", () => {
  test("extracts package.json bin and main as entry chunk", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const chunks = await loadRootEntryChunks(repoRoot, repoRoot);

    expect(chunks.length).toBeGreaterThan(0);
    const entry = chunks[0];
    expect(entry?.file_path).toBe("package.json");
    expect(entry?.content).toContain("[package entry]");
    expect(entry?.content).toContain("bin miru:");
    expect(entry?.content).toContain("./src/cli.ts");
    expect(entry?.content).toContain("main:");
  });
});
