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

  test("tools/list asks Claude Code to load the code-search tools upfront", async () => {
    const transport = new MemoryTransport([
      { jsonrpc: "2.0" as const, id: 1, method: "tools/list" },
    ]);
    await createMcpServer({ get: async () => ({}) } as unknown as IndexCache).connect(transport);
    const response = transport.responseFor(1);
    if (!response || !("result" in response)) throw new Error("missing tools/list result");
    const tools = (response.result as { tools: Array<{ name: string; _meta?: unknown }> }).tools;
    for (const name of ["search", "locate", "expand", "find_related"]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toEqual({
        "anthropic/alwaysLoad": true,
      });
    }
  });

  test("locate lists files by include glob when no literal is given", async () => {
    const chunks: Chunk[] = [
      { ...sourceChunk, file_path: "src/a.test.ts" },
      { ...sourceChunk, file_path: "src/b.ts" },
      { ...sourceChunk, file_path: "tests/c.test.ts" },
    ];
    const cache = { get: async () => ({ root: null, chunks }) } as unknown as IndexCache;
    const transport = new MemoryTransport([
      call(1, "locate", { include: ["**/*.test.ts"] }),
      call(2, "locate", { include: ["**/*.test.ts"], mode: "count" }),
      call(3, "locate", {}),
    ]);
    await createMcpServer(cache).connect(transport);
    expect(payload(transport, 1)).toBe("2 files\n\nsrc/a.test.ts\ntests/c.test.ts");
    expect(payload(transport, 2)).toBe("2 files");
    const missing = transport.responseFor(3);
    expect(JSON.stringify(missing)).toContain("include");
  });

  test("locate runs a /regex/ literal and files mode over indexed chunks", async () => {
    const chunks: Chunk[] = [sourceChunk, { ...sourceChunk, file_path: "src/other.ts" }];
    const { locateLiteral } = await import("../src/literal.ts");
    const cache = {
      get: async () => ({
        root: null,
        chunks,
        locateLiteral: (lit: string, opts: object) => locateLiteral(chunks, lit, opts),
      }),
    } as unknown as IndexCache;
    const transport = new MemoryTransport([
      call(1, "locate", { literal: "/find\\w+\\(/", mode: "files" }),
      call(2, "locate", { literal: "/find\\w+\\(/", mode: "locations" }),
    ]);
    await createMcpServer(cache).connect(transport);
    expect(payload(transport, 1)).toContain("2 files");
    expect(payload(transport, 1)).toContain("src/\n  find.ts\n  other.ts");
    expect(payload(transport, 2)).toContain("src/find.ts: 1");
  });

  test("benchmark mode skips the fixed-string baseline for regex and files-mode locate", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-mcp-regex-skip-"));
    try {
      const { locateLiteral } = await import("../src/literal.ts");
      const index = {
        root,
        chunks: [sourceChunk],
        locateLiteral: (lit: string, opts: object) => locateLiteral([sourceChunk], lit, opts),
      };
      const transport = new MemoryTransport([
        call(1, "locate", { literal: "/find\\w+/", repo: root }),
        call(2, "locate", { literal: "needle", mode: "files", repo: root }),
        call(3, "locate", { include: ["src/**"], repo: root }),
      ]);
      await createMcpServer({ get: async () => index } as unknown as IndexCache, {
        benchmark: true,
      }).connect(transport);
      for (const id of [1, 2, 3]) {
        expect(payload(transport, id)).toContain('"benchmark_skipped":"regex_or_file_list"');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the server startup directory when repo is omitted and honors an explicit repo", async () => {
    const startupDirectory = process.cwd();
    const sources: string[] = [];
    const fakeIndex = {
      root: null,
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
    const cache = {
      get: async (source: string) => {
        sources.push(source);
        return fakeIndex;
      },
    } as unknown as IndexCache;
    const transport = new MemoryTransport([
      call(1, "search", { query: "findThing" }),
      call(2, "locate", { literal: "needle", mode: "count" }),
      call(3, "expand", { file_path: sourceChunk.file_path, anchor_line: 1 }),
      call(4, "find_related", { file_path: sourceChunk.file_path, anchor_line: 1 }),
      call(5, "search", { query: "findThing", repo: "/another/repo" }),
    ]);

    await createMcpServer(cache).connect(transport);

    expect(sources).toEqual([
      startupDirectory,
      startupDirectory,
      startupDirectory,
      startupDirectory,
      "/another/repo",
    ]);
    expect(payload(transport, 1)).toContain("findThing");
    expect(payload(transport, 2)).toContain("1 match across 1 file");
    expect(payload(transport, 3)).toContain("needle");
    expect(payload(transport, 4)).toContain("findThing");
    expect(payload(transport, 5)).toContain("findThing");
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
        call(4, "search", { query: "none", repo: `${root}-index-error` }),
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
