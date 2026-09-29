import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResultsText } from "../src/mcp/format-text.ts";
import type { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import type { Chunk, SearchResult } from "../src/types.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";

const sourceChunk: Chunk = {
  content: "export function findThing() { return 'needle'; }",
  file_path: "src/find.ts",
  start_line: 1,
  end_line: 3,
  language: "typescript",
};
const searchResults: SearchResult[] = [{ chunk: sourceChunk, score: 1 }];

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id, method: "tools/call", params: { name, arguments: args } };
}

function payload(transport: MemoryTransport, id: number): string {
  const response = transport.responseFor(id);
  if (!response || !("result" in response)) throw new Error(`missing result ${id}`);
  return (response.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

describe("MCP tools against a local index", () => {
  test("formats empty results", () => {
    expect(formatResultsText({ query: "nothing", results: [] })).toBe("No results found.");
  });

  test("searches, locates, expands, and finds related chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-mcp-tools-"));
    try {
      await mkdir(join(root, "src"));
      await Bun.write(join(root, "src", "find.ts"), `${sourceChunk.content}\n`);
      const fakeIndex = {
        root,
        chunks: [sourceChunk],
        search: async () => searchResults,
        locateLiteral: () => ({
          literal: "needle",
          mode: "count",
          n: 1,
          files: 1,
          truncated: false,
          hits: [],
        }),
        findRelated: async () => searchResults,
      };
      const fakeCache = { get: async () => fakeIndex } as unknown as IndexCache;
      const transport = new MemoryTransport([
        call(1, "search", { query: "findThing", repo: root }),
        call(2, "locate", { literal: "needle", repo: root, mode: "count" }),
        call(3, "expand", { file_path: sourceChunk.file_path, anchor_line: 1, repo: root }),
        call(4, "find_related", { file_path: sourceChunk.file_path, anchor_line: 1, repo: root }),
      ]);
      await createMcpServer(fakeCache).connect(transport);
      expect(payload(transport, 1)).toContain("findThing");
      expect(payload(transport, 2)).toContain("1 match across 1 file");
      expect(payload(transport, 3)).toContain("needle");
      expect(payload(transport, 4)).toContain("findThing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns clear messages for empty results, missing chunks, and index errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-mcp-empty-"));
    try {
      const fakeIndex = {
        root,
        chunks: [],
        search: async () => [],
        locateLiteral: () => ({
          literal: "none",
          mode: "lines",
          n: 0,
          files: 0,
          truncated: false,
          hits: [],
        }),
        findRelated: async () => [],
      };
      const empty = {
        get: async (source: string) => {
          if (source.includes("index-error")) throw new Error("offline");
          return fakeIndex;
        },
      } as unknown as IndexCache;
      const transport = new MemoryTransport([
        call(1, "search", { query: "none", repo: root }),
        call(2, "expand", { file_path: "missing.ts", anchor_line: 1, repo: root }),
        call(3, "find_related", { file_path: "missing.ts", anchor_line: 1, repo: root }),
        call(4, "search", { query: "none", repo: root + "-index-error" }),
      ]);
      await createMcpServer(empty).connect(transport);
      expect(payload(transport, 1)).toContain("No results found");
      expect(payload(transport, 2)).toContain("No chunk found");
      expect(payload(transport, 3)).toContain("No chunk found");
      expect(payload(transport, 4)).toContain("Failed to index");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("covers missing locate input and benchmark skip notes", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-mcp-skip-"));
    try {
      await mkdir(join(root, "src"));
      await Bun.write(join(root, "src", "find.ts"), "different indexed source\n");
      const fakeIndex = {
        root,
        chunks: [sourceChunk],
        search: async () => searchResults,
        locateLiteral: () => ({
          literal: "needle",
          mode: "count",
          n: 1,
          files: 1,
          truncated: false,
          hits: [],
        }),
        findRelated: async () => [],
      };
      const cache = {
        get: async (source: string) =>
          source.includes("-locate-error")
            ? {
                ...fakeIndex,
                locateLiteral: () => {
                  throw new Error("locate failure");
                },
              }
            : fakeIndex,
      } as unknown as IndexCache;
      const transport = new MemoryTransport([
        call(1, "locate", { repo: root }),
        call(2, "search", { query: "findThing", repo: root, include: ["src/**"] }),
        call(3, "find_related", { file_path: sourceChunk.file_path, anchor_line: 1, repo: root }),
        call(4, "locate", { literal: "needle", repo: "https://example.test/org/repo" }),
      ]);
      await createMcpServer(cache, { benchmark: true }).connect(transport);

      expect(payload(transport, 1)).toContain("locate requires");
      expect(payload(transport, 2)).toContain('"benchmark_skipped":"filtered_search"');
      expect(payload(transport, 3)).toContain("No related chunks found");
      expect(payload(transport, 4)).toContain('"benchmark_skipped":"local_repo_only"');

      const noSourceIndex = { ...fakeIndex, root: null };
      const localOnlyTransport = new MemoryTransport([
        call(5, "search", { query: "findThing", repo: "https://example.test/org/repo" }),
      ]);
      await createMcpServer({ get: async () => noSourceIndex } as unknown as IndexCache, {
        benchmark: true,
      }).connect(localOnlyTransport);
      expect(payload(localOnlyTransport, 5)).toContain('"benchmark_skipped":"local_repo_only"');

      const benchmarkEmptyTransport = new MemoryTransport([
        call(6, "search", { query: "findThing", repo: root }),
      ]);
      await createMcpServer(cache, {
        benchmark: true,
        dependencies: {
          benchmarkSearchComparison: async () => ({ results: [] }) as never,
        },
      }).connect(benchmarkEmptyTransport);
      expect(payload(benchmarkEmptyTransport, 6)).toBe("No results found.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns benchmark timeout notes and preserves errors from related search and history", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-mcp-timeout-"));
    try {
      await mkdir(join(root, "src"));
      await Bun.write(join(root, "src", "find.ts"), `${sourceChunk.content}\n`);
      const fakeIndex = {
        root,
        chunks: [sourceChunk],
        search: async () => searchResults,
        locateLiteral: () => ({
          literal: "needle",
          mode: "count",
          n: 1,
          files: 1,
          truncated: false,
          hits: [],
        }),
        findRelated: async () => {
          throw new Error("related failure");
        },
      };
      const cache = {
        get: async (source: string) =>
          source.includes("-locate-error")
            ? {
                ...fakeIndex,
                locateLiteral: () => {
                  throw new Error("locate failure");
                },
              }
            : fakeIndex,
      } as unknown as IndexCache;
      let baselineChecks = 0;
      const transport = new MemoryTransport([
        call(1, "search", { query: "findThing", repo: root }),
        call(2, "locate", { literal: "needle", repo: root, limit: 1 }),
        call(3, "locate", { literal: "needle", repo: root }),
        call(4, "locate", { literal: "needle", repo: root }),
        call(5, "locate", { literal: "needle", repo: `${root}-locate-error` }),
        call(6, "find_related", { file_path: sourceChunk.file_path, anchor_line: 1, repo: root }),
        call(7, "read_benchmark", {}),
      ]);
      await createMcpServer(cache, {
        benchmark: true,
        dependencies: {
          withGrepTimeoutFallback: async <T>(_run: () => Promise<T>) => null,
          selectComparableLiteralSearchTool: () => (++baselineChecks > 1 ? "rg" : null),
          readBenchmarkRollup: async () => {
            throw new Error("history unavailable");
          },
        },
      }).connect(transport);

      expect(payload(transport, 1)).toContain('"benchmark_skipped":"grep_timeout"');
      expect(payload(transport, 2)).toContain('"benchmark_skipped":"limited_locate"');
      expect(payload(transport, 3)).toContain(
        '"benchmark_skipped":"incompatible_literal_baseline"',
      );
      expect(payload(transport, 4)).toContain('"benchmark_skipped":"grep_timeout"');
      expect(payload(transport, 5)).toContain("locate failure");
      expect(payload(transport, 6)).toContain("related failure");
      expect(payload(transport, 7)).toContain("history unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
