import { afterEach, describe, expect, test } from "bun:test";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { BM25Index } from "../src/index/bm25.ts";
import { VectorIndex } from "../src/index/dense.ts";
import {
  boostExactStemMatches,
  boostLocationSignals,
  isEntryPointQuery,
  isLocationQuery,
  penalizeInstallerForLocation,
} from "../src/ranking/location.ts";
import { hybridSearch } from "../src/search.ts";
import type { Chunk } from "../src/types.ts";
import { chunkKey } from "../src/types.ts";
import { unitVector } from "./test-helpers.ts";

function chunk(content: string, file: string, start = 1, end = 20): Chunk {
  return {
    content,
    file_path: file,
    start_line: start,
    end_line: end,
    language: "typescript",
  };
}

function mockEmbeddings(dim: number): EmbeddingBackend {
  const neutral = unitVector(dim, 0, 1);
  return {
    model: "mock",
    dimensions: dim,
    async embedDocuments(texts: string[]) {
      return texts.map(() => neutral);
    },
    async embedQuery() {
      return neutral;
    },
  };
}

const originalV2 = process.env.MIRU_SEARCH_V2;

afterEach(() => {
  if (originalV2 === undefined) {
    delete process.env.MIRU_SEARCH_V2;
  } else {
    process.env.MIRU_SEARCH_V2 = originalV2;
  }
});

describe("isLocationQuery", () => {
  test("detects where and entry-point phrasing", () => {
    expect(isLocationQuery("CLI entry point main command line interface")).toBe(true);
    expect(isLocationQuery("where is cli-ui terminal output")).toBe(true);
    expect(isLocationQuery("hybrid search ranking BM25")).toBe(false);
    expect(isEntryPointQuery("CLI entry point main command line interface")).toBe(true);
    expect(isEntryPointQuery("where is cli-ui terminal output")).toBe(false);
  });
});

describe("location ranking boosts", () => {
  test("boostExactStemMatches favors cli.ts for cli query token", () => {
    const cliChunk = chunk("export function runCli() {}", "src/cli.ts");
    const otherChunk = chunk("merge hooks for agents", "src/installer/hooks/install.ts");
    const chunksByKey = new Map([
      [chunkKey(cliChunk), cliChunk],
      [chunkKey(otherChunk), otherChunk],
    ]);
    const scores = new Map([
      [chunkKey(cliChunk), 1],
      [chunkKey(otherChunk), 1],
    ]);

    boostExactStemMatches(scores, "where is the cli code", 1, chunksByKey);

    expect(scores.get(chunkKey(cliChunk))).toBeGreaterThan(scores.get(chunkKey(otherChunk)) ?? 0);
  });

  test("boostLocationSignals favors main() chunk", () => {
    const mainChunk = chunk(
      "async function main() {\n  await runCli(argv);\n}",
      "src/cli.ts",
      450,
      470,
    );
    const middleChunk = chunk("async function runCli(argv) {}", "src/cli.ts", 250, 400);
    const chunksByKey = new Map([
      [chunkKey(mainChunk), mainChunk],
      [chunkKey(middleChunk), middleChunk],
    ]);
    const scores = new Map([
      [chunkKey(mainChunk), 1],
      [chunkKey(middleChunk), 2],
    ]);

    boostLocationSignals(scores, "CLI entry point", 1, [mainChunk, middleChunk], chunksByKey);

    expect(scores.get(chunkKey(mainChunk))).toBeGreaterThan(scores.get(chunkKey(middleChunk)) ?? 0);
  });

  test("boostExactStemMatches skips package stem when command.go is the target", () => {
    const cobraChunk = chunk("package cobra", "cobra.go");
    const commandChunk = chunk("type Command struct {}", "command.go");
    const scores = new Map([
      [chunkKey(cobraChunk), 1],
      [chunkKey(commandChunk), 1],
    ]);
    const chunksByKey = new Map([
      [chunkKey(cobraChunk), cobraChunk],
      [chunkKey(commandChunk), commandChunk],
    ]);

    boostExactStemMatches(scores, "cobra command CLI execute flags", 1, chunksByKey);

    expect(scores.get(chunkKey(cobraChunk))).toBe(1);
    expect(scores.get(chunkKey(commandChunk))).toBe(1);
  });

  test("boostExactStemMatches ignores generic tokens like route", () => {
    const routeChunk = chunk("pub struct Route;", "axum/src/routing/route.rs");
    const modChunk = chunk("mod router;", "axum/src/routing/mod.rs");
    const scores = new Map([
      [chunkKey(routeChunk), 1],
      [chunkKey(modChunk), 1],
    ]);
    const chunksByKey = new Map([
      [chunkKey(routeChunk), routeChunk],
      [chunkKey(modChunk), modChunk],
    ]);

    boostExactStemMatches(scores, "HTTP router route matching axum", 1, chunksByKey);

    expect(scores.get(chunkKey(routeChunk))).toBe(1);
    expect(scores.get(chunkKey(modChunk))).toBe(1);
  });

  test("boostExactStemMatches prefers cli-ui.ts over cli.ts for hyphenated query", () => {
    const cliChunk = chunk("async function main() {}", "src/cli.ts");
    const cliUiChunk = chunk("export function writeStdout() {}", "src/cli-ui.ts");
    const scores = new Map([
      [chunkKey(cliChunk), 1],
      [chunkKey(cliUiChunk), 1],
    ]);
    const chunksByKey = new Map([
      [chunkKey(cliChunk), cliChunk],
      [chunkKey(cliUiChunk), cliUiChunk],
    ]);

    boostExactStemMatches(scores, "where is cli-ui terminal output", 1, chunksByKey);

    expect(scores.get(chunkKey(cliChunk))).toBe(1);
    expect(scores.get(chunkKey(cliUiChunk))).toBeGreaterThan(1);
  });

  test("location boosts match normalized stems and skip unrelated entry points", () => {
    const cli = chunk("function main() {}", "src/cli-ui.ts");
    const unrelated = chunk("function main() {}", "src/other.ts");
    const byKey = new Map([
      [chunkKey(cli), cli],
      [chunkKey(unrelated), unrelated],
    ]);
    const scores = new Map<string, number>();
    boostLocationSignals(scores, "where is cli_ui defined", 1, [cli, unrelated], byKey);
    expect(scores.has(chunkKey(cli))).toBe(true);
    expect(scores.has(chunkKey(unrelated))).toBe(false);

    const noLocation = new Map<string, number>();
    boostLocationSignals(noLocation, "search ranking", 1, [cli], byKey);
    expect(noLocation.size).toBe(0);

    const cliMain = chunk("function main() {}", "src/cli.ts");
    const hyphenScores = new Map<string, number>();
    const hyphenChunks = new Map<string, Chunk>([[chunkKey(cliMain), cliMain]]);
    boostLocationSignals(hyphenScores, "where is cli-ui defined", 1, [cliMain], hyphenChunks);
    expect(hyphenScores.has(chunkKey(cliMain))).toBe(false);
    const exactScores = new Map<string, number>();
    boostLocationSignals(exactScores, "where is cli defined", 1, [cliMain], hyphenChunks);
    expect(exactScores.has(chunkKey(cliMain))).toBe(true);
  });

  test("exact stem boosts skip missing chunks, generic words, and incidental implementation names", () => {
    const handler = chunk("handle requests", "src/handler.ts");
    const utility = chunk("specific logic", "src/foo.ts");
    const scores = new Map([
      [chunkKey(handler), 1],
      [chunkKey(utility), 1],
      ["missing", 1],
    ]);
    const byKey = new Map([
      [chunkKey(handler), handler],
      [chunkKey(utility), utility],
    ]);
    boostExactStemMatches(scores, "handler foo", 1, byKey);
    expect(scores.get(chunkKey(handler))).toBe(1);
    expect(scores.get(chunkKey(utility))).toBe(1);

    const noKeywords = new Map([[chunkKey(handler), 1]]);
    boostExactStemMatches(noKeywords, "???", 1, byKey);
    expect(noKeywords.get(chunkKey(handler))).toBe(1);

    const searchImplementation = chunk("implementation details", "src/search.ts");
    const commandImplementation = chunk("command implementation", "src/command.ts");
    const implementationScores = new Map([
      [chunkKey(searchImplementation), 1],
      [chunkKey(commandImplementation), 1],
    ]);
    boostExactStemMatches(
      implementationScores,
      "command search",
      1,
      new Map([
        [chunkKey(searchImplementation), searchImplementation],
        [chunkKey(commandImplementation), commandImplementation],
      ]),
    );
    expect(implementationScores.get(chunkKey(searchImplementation))).toBe(1);

    const installer = chunk("install", "src/installer/setup.ts");
    const integrationScores = new Map([[chunkKey(installer), 2]]);
    penalizeInstallerForLocation(
      integrationScores,
      "where do we setup hooks",
      new Map([[chunkKey(installer), installer]]),
    );
    expect(integrationScores.get(chunkKey(installer))).toBe(2);
  });

  test("penalizeInstallerForLocation demotes installer on location queries", () => {
    const installChunk = chunk(
      "export async function mergeClaudeHooks",
      "src/installer/hooks/install.ts",
    );
    const scores = new Map([[chunkKey(installChunk), 2]]);
    const chunksByKey = new Map([[chunkKey(installChunk), installChunk]]);

    penalizeInstallerForLocation(scores, "CLI entry point", chunksByKey);

    expect(scores.get(chunkKey(installChunk))).toBeLessThan(1);
  });
});

describe("hybridSearch with MIRU_SEARCH_V2", () => {
  test("location query ranks cli main above installer hooks", async () => {
    process.env.MIRU_SEARCH_V2 = "1";

    const mainChunk = chunk(
      "#!/usr/bin/env bun\nasync function main() {\n  await runCli(argv);\n}",
      "src/cli.ts",
      1,
      20,
    );
    const runCliChunk = chunk(
      "async function runCli(argv: string[]) {\n  // command router\n}",
      "src/cli.ts",
      250,
      415,
    );
    const installChunk = chunk(
      "export async function mergeClaudeHooks(path: string) {}",
      "src/installer/hooks/install.ts",
    );
    const pkgChunk = chunk("[package entry]\nbin miru: ./src/cli.ts\n", "package.json");

    const chunks = [mainChunk, runCliChunk, installChunk, pkgChunk];
    const vectors = chunks.map((_, i) => unitVector(8, i % 8, 1));
    const bm25 = new BM25Index();
    bm25.index(chunks.map((c) => c.content.toLowerCase().split(/\W+/).filter(Boolean)));
    const semantic = new VectorIndex(vectors);

    const results = await hybridSearch({
      query: "CLI entry point main command line interface",
      embeddings: mockEmbeddings(8),
      semanticIndex: semantic,
      bm25Index: bm25,
      chunks,
      topK: 3,
      alpha: 0.5,
      rerank: true,
    });

    const files = results.map((r) => r.chunk.file_path);
    expect(files).toContain("src/cli.ts");
    expect(files).not.toContain("src/installer/hooks/install.ts");
    const firstCli = results.find((r) => r.chunk.file_path === "src/cli.ts");
    expect(firstCli?.chunk.content).toMatch(/main\s*\(/);
  });
});
