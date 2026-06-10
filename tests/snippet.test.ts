import { describe, expect, test } from "bun:test";
import { anchorLineOffset, applySnippetsToResults, trimChunkToSnippet } from "../src/snippet.ts";
import type { Chunk } from "../src/types.ts";

function chunk(content: string, start = 1): Chunk {
  const lines = content.split("\n");
  return {
    content,
    file_path: "src/a.ts",
    start_line: start,
    end_line: start + lines.length - 1,
    language: "typescript",
  };
}

describe("trimChunkToSnippet", () => {
  test("truncates around query-matching line", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines[20] = "async function hybridSearch() {}";
    const body = lines.join("\n");
    const { chunk: trimmed, meta } = trimChunkToSnippet(chunk(body), "hybrid search ranking", 5);

    expect(meta.truncated).toBe(true);
    expect(trimmed.content).toContain("hybridSearch");
    expect(trimmed.content.split("\n").length).toBeLessThanOrEqual(11);
    expect(meta.anchor_line).toBe(21);
    expect(meta.full_start_line).toBe(1);
    expect(meta.full_end_line).toBe(40);
  });

  test("leaves small chunks unchanged", () => {
    const small = chunk("export function main() {}\n");
    const { chunk: trimmed, meta } = trimChunkToSnippet(small, "main entry", 15);
    expect(meta.truncated).toBe(false);
    expect(trimmed.content).toBe(small.content);
  });

  test("anchorLineOffset prefers keyword lines", () => {
    const content = "import x\n\nfunction unrelated() {}\n\nfunction cliUi() {}\n";
    expect(anchorLineOffset(content, "cli-ui terminal")).toBe(4);
  });

  test("applySnippetsToResults reduces token estimate", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `// filler ${i}`).join("\n");
    const big = chunk(`${lines}\nexport function target() {}\n${lines}`);
    const results = [{ chunk: big, score: 1 }];
    const fullTokens = Math.floor(big.content.length / 4);
    const snippetLen =
      applySnippetsToResults(results, "target function")[0]?.result.chunk.content.length ?? 0;
    const snippetTokens = Math.floor(snippetLen / 4);
    expect(snippetTokens).toBeLessThan(fullTokens / 2);
  });
});
