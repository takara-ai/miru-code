import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  attachSearchBenchmark,
  benchmarkSearchComparison,
  toAgentBenchmarkSummary,
} from "../src/benchmark/compare.ts";
import { loadBenchmarkHistory, runWithBenchmarkHistoryPath } from "../src/benchmark/history.ts";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { countTokens } from "../src/token-count.ts";
import { computeSourceCacheKey, formatResults } from "../src/utils.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";
import { unitVector } from "./test-helpers.ts";

function hashToVector(text: string, dim = 32): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + (text.charCodeAt(i) ?? 0)) >>> 0;
  }
  return unitVector(dim, h % dim);
}

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-benchmark",
    dimensions: 32,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => hashToVector(text));
    },
    async embedQuery(text: string) {
      return hashToVector(text);
    },
  };
}

type CacheEntryInternal = {
  index: MiruIndex | null;
  task: Promise<MiruIndex> | null;
};

type IndexCacheTestAccess = {
  ensureEntry(cacheKey: string, source?: string): CacheEntryInternal;
};

async function buildTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miru-bench-e2e-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/auth.ts"),
    [
      "export function authenticateUser(token: string) {",
      "  return token === 'miruAuthSecretToken';",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    join(root, "src/billing.ts"),
    ["export function chargeCustomer(amount: number) {", "  return amount * 100;", "}", ""].join(
      "\n",
    ),
    "utf-8",
  );
  return resolve(root);
}

async function buildIndex(root: string): Promise<MiruIndex> {
  const embeddings = mockEmbeddings();
  const built = await createIndexFromPath(root, embeddings, ["code"], root);
  return new MiruIndex({
    embeddings,
    bm25Index: built.bm25,
    semanticIndex: built.semantic,
    chunks: built.chunks,
    embeddingModel: embeddings.model,
    root,
    content: ["code"],
  });
}

function preloadCache(cache: IndexCache, root: string, index: MiruIndex): void {
  const cacheKey = computeSourceCacheKey(root);
  const internals = cache as unknown as IndexCacheTestAccess;
  const entry = internals.ensureEntry(cacheKey, root);
  entry.index = index;
  entry.task = Promise.resolve(index);
}

function parseToolText(response: unknown): string {
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error("missing tools/call result");
  }
  const content = (response as { result: { content: Array<{ text: string }> } }).result.content;
  return content[0]?.text ?? "";
}

function parseToolJson(response: unknown): Record<string, unknown> {
  return JSON.parse(parseToolText(response) || "{}") as Record<string, unknown>;
}

/** Split plaintext MCP body from trailing `{"benchmark":...}` line. */
function parseBenchmarkToolText(response: unknown): {
  body: string;
  benchmark: Record<string, unknown>;
} {
  const text = parseToolText(response);
  const marker = '\n\n{"benchmark":';
  const idx = text.lastIndexOf(marker);
  if (idx < 0) {
    throw new Error("missing benchmark trailer");
  }
  const trailer = JSON.parse(text.slice(idx + 2)) as { benchmark: Record<string, unknown> };
  return { body: text.slice(0, idx), benchmark: trailer.benchmark };
}

describe("benchmark MCP end-to-end", () => {
  test("comparison produces compact agent summary and absolute savings", async () => {
    const root = await buildTempRepo();
    try {
      const index = await buildIndex(root);
      const comparison = await benchmarkSearchComparison({
        query: "authenticateUser miruAuthSecretToken",
        repoPath: root,
        index,
        topK: 3,
      });

      expect(comparison.results.length).toBeGreaterThan(0);
      expect(comparison.benchmark.miru.workflow_tokens).toBeGreaterThan(0);
      expect(comparison.benchmark.grep_read.workflow_full_tokens).toBeGreaterThan(0);

      const summary = toAgentBenchmarkSummary(comparison.benchmark);
      expect(summary.miru_tok).toBe(comparison.benchmark.miru.workflow_tokens);
      expect(summary.grep_tok).toBe(comparison.benchmark.grep_read.workflow_full_tokens);
      expect(summary.saved_tok).toBe(Math.max(0, summary.grep_tok - summary.miru_tok));
      expect(summary).toMatchObject({
        save_pct: expect.any(Number),
        miru_tok: expect.any(Number),
        grep_tok: expect.any(Number),
        saved_tok: expect.any(Number),
        rank1: expect.any(Boolean),
      });
      for (const key of Object.keys(summary)) {
        expect([
          "save_pct",
          "miru_tok",
          "grep_tok",
          "saved_tok",
          "rank1",
          "miru_only",
          "search_tok",
        ]).toContain(key);
      }

      const attached = attachSearchBenchmark(
        formatResults("authenticateUser miruAuthSecretToken", comparison.results, {
          repoRoot: root,
          snippet: true,
        }),
        comparison.benchmark,
      );
      expect(attached.benchmark).toEqual(summary);
      expect(JSON.stringify(attached.benchmark).length).toBeLessThan(
        JSON.stringify(comparison.benchmark).length / 2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("benchmarkSearchComparison honors dedupeByFile=false", async () => {
    const root = await buildTempRepo();
    try {
      const index = await buildIndex(root);
      const sameFileChunks = index.chunks.filter((c) => c.file_path.includes("auth"));
      const chunkA = sameFileChunks[0];
      expect(chunkA).toBeDefined();
      if (!chunkA) {
        throw new Error("expected auth chunk");
      }
      const chunkB = sameFileChunks[1] ?? {
        ...chunkA,
        start_line: chunkA.start_line + 1,
        end_line: chunkA.end_line + 1,
      };
      const other = index.chunks.find((c) => c.file_path.includes("billing")) ?? index.chunks[0];
      if (!other) {
        throw new Error("expected at least one indexed chunk");
      }

      index.search = async () => [
        { score: 3, chunk: chunkA },
        { score: 2, chunk: chunkB },
        { score: 1, chunk: other },
      ];

      const deduped = await benchmarkSearchComparison({
        query: "authenticateUser",
        repoPath: root,
        index,
        topK: 5,
        dedupeByFile: true,
      });
      const undeduped = await benchmarkSearchComparison({
        query: "authenticateUser",
        repoPath: root,
        index,
        topK: 5,
        dedupeByFile: false,
      });

      const dedupedSameFile = deduped.results.filter((r) => r.chunk.file_path === chunkA.file_path);
      const undedupedSameFile = undeduped.results.filter(
        (r) => r.chunk.file_path === chunkA.file_path,
      );
      expect(dedupedSameFile).toHaveLength(1);
      expect(undedupedSameFile.length).toBeGreaterThan(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("MCP search persists history and read_benchmark returns compact rollup", async () => {
    const root = await buildTempRepo();
    const historyDir = await mkdtemp(join(tmpdir(), "miru-bench-hist-e2e-"));
    const historyPath = join(historyDir, "benchmark-history.json");

    try {
      await runWithBenchmarkHistoryPath(historyPath, async () => {
        const index = await buildIndex(root);
        const cache = new IndexCache(["code"]);
        preloadCache(cache, root, index);
        const server = createMcpServer(cache, { benchmark: true });

        const transport = new MemoryTransport([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "bench-e2e", version: "1.0.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "search",
              arguments: {
                query: "authenticateUser miruAuthSecretToken",
                repo: root,
                top_k: 3,
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "search",
              arguments: {
                query: "chargeCustomer billing amount",
                repo: root,
                top_k: 3,
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "read_benchmark",
              arguments: {},
            },
          },
        ]);

        await server.connect(transport);

        const searchOne = parseBenchmarkToolText(transport.responseFor(2));
        const searchTwo = parseBenchmarkToolText(transport.responseFor(3));
        expect(searchOne.body.length).toBeGreaterThan(0);
        expect(searchTwo.body.length).toBeGreaterThan(0);
        expect(searchOne.body.startsWith("{")).toBe(false);
        expect(searchTwo.body.startsWith("{")).toBe(false);

        const benchOne = searchOne.benchmark as {
          save_pct: number;
          miru_tok: number;
          grep_tok: number;
          saved_tok: number;
          rank1: boolean;
          search_tok?: number;
        };
        const benchTwo = searchTwo.benchmark as typeof benchOne;
        expect(benchOne.miru_tok).toBeGreaterThan(0);
        expect(benchTwo.miru_tok).toBeGreaterThan(0);
        expect(benchOne.search_tok).toBeGreaterThan(0);
        expect(benchOne.search_tok).toBeLessThanOrEqual(benchOne.miru_tok);
        expect(benchOne.search_tok).toBe(countTokens(searchOne.body));
        expect(benchTwo.search_tok).toBe(countTokens(searchTwo.body));
        expect(benchOne.saved_tok).toBe(Math.max(0, benchOne.grep_tok - benchOne.miru_tok));
        expect(benchTwo.saved_tok).toBe(Math.max(0, benchTwo.grep_tok - benchTwo.miru_tok));
        expect(
          Object.keys(benchOne).every((key) =>
            [
              "save_pct",
              "miru_tok",
              "grep_tok",
              "saved_tok",
              "rank1",
              "miru_only",
              "search_tok",
            ].includes(key),
          ),
        ).toBe(true);

        const history = await loadBenchmarkHistory(historyPath);
        expect(history.n).toBe(2);
        expect(history.miru).toBe(benchOne.miru_tok + benchTwo.miru_tok);
        expect(history.grep).toBe(benchOne.grep_tok + benchTwo.grep_tok);
        expect(history.saved).toBe(benchOne.saved_tok + benchTwo.saved_tok);

        const rollup = parseToolJson(transport.responseFor(4)) as {
          n: number;
          saved: number;
          save_pct: number;
          miru: number;
          grep: number;
          recent?: unknown;
          repos?: unknown;
          history_path?: unknown;
        };
        expect(rollup.n).toBe(2);
        expect(rollup.saved).toBe(benchOne.saved_tok + benchTwo.saved_tok);
        expect(rollup.miru).toBe(benchOne.miru_tok + benchTwo.miru_tok);
        expect(rollup.grep).toBe(benchOne.grep_tok + benchTwo.grep_tok);
        expect(rollup.recent).toBeUndefined();
        expect(rollup.repos).toBeUndefined();
        expect(rollup.history_path).toBeUndefined();
        expect(Object.keys(rollup).sort()).toEqual(["grep", "miru", "n", "save_pct", "saved"]);

        cache.close();
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(historyDir, { recursive: true, force: true });
    }
  });

  test("MCP locate in benchmark mode attaches savings and rolls into read_benchmark", async () => {
    const root = await buildTempRepo();
    const historyDir = await mkdtemp(join(tmpdir(), "miru-locate-bench-hist-"));
    const historyPath = join(historyDir, "benchmark-history.json");

    try {
      await runWithBenchmarkHistoryPath(historyPath, async () => {
        const index = await buildIndex(root);
        const cache = new IndexCache(["code"]);
        preloadCache(cache, root, index);
        const server = createMcpServer(cache, { benchmark: true });

        const transport = new MemoryTransport([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "locate-bench-e2e", version: "1.0.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "locate",
              arguments: {
                literal: "miruAuthSecretToken",
                repo: root,
                mode: "locations",
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "read_benchmark",
              arguments: {},
            },
          },
        ]);

        await server.connect(transport);

        const locate = parseBenchmarkToolText(transport.responseFor(2));
        expect(locate.body).toContain("miruAuthSecretToken");
        expect(locate.body.startsWith("{")).toBe(false);
        const locateBench = locate.benchmark as {
          save_pct: number;
          miru_tok: number;
          grep_tok: number;
          saved_tok: number;
          rank1: boolean;
        };
        expect(locateBench.grep_tok).toBeGreaterThan(locateBench.miru_tok);
        expect(locateBench.saved_tok).toBe(locateBench.grep_tok - locateBench.miru_tok);
        expect(Object.keys(locateBench).sort()).toEqual([
          "grep_tok",
          "miru_tok",
          "rank1",
          "save_pct",
          "saved_tok",
        ]);

        const rollup = parseToolJson(transport.responseFor(3)) as {
          n: number;
          saved: number;
          miru: number;
          grep: number;
          recent?: unknown;
        };
        expect(rollup.n).toBe(1);
        expect(rollup.saved).toBe(locateBench.saved_tok);
        expect(rollup.miru).toBe(locateBench.miru_tok);
        expect(rollup.grep).toBe(locateBench.grep_tok);
        expect(rollup.recent).toBeUndefined();

        cache.close();
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(historyDir, { recursive: true, force: true });
    }
  });

  test("normal MCP mode does not expose read_benchmark", async () => {
    const server = createMcpServer(new IndexCache(), { benchmark: false });
    const transport = new MemoryTransport([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "bench-off", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    await server.connect(transport);
    const list = transport.responseFor(2);
    if (!list || !("result" in list)) {
      throw new Error("missing tools/list");
    }
    const names = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(["auth", "search", "locate", "expand", "find_related"]);
  });
});
