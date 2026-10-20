import { join } from "node:path";
import * as z from "zod";
import packageJson from "../../package.json";
import { benchmarkSearchComparison, toAgentBenchmarkSummary } from "../benchmark/compare.ts";
import { withGrepTimeoutFallback } from "../benchmark/grep.ts";
import {
  appendBenchmarkQuery,
  readBenchmarkRollup,
  recordFromAgentSummary,
  recordFromBenchmark,
} from "../benchmark/history.ts";
import { benchmarkLocateComparison } from "../benchmark/locate-compare.ts";
import { selectComparableLiteralSearchTool } from "../benchmark/rg-literal.ts";
import { appendAgentBenchmark } from "../benchmark/summary.ts";
import {
  MCP_BENCHMARK_SERVER_INSTRUCTIONS,
  MCP_EXPAND_TOOL_DESCRIPTION,
  MCP_FIND_RELATED_TOOL_DESCRIPTION,
  MCP_LOCATE_TOOL_DESCRIPTION,
  MCP_READ_BENCHMARK_TOOL_DESCRIPTION,
  MCP_SEARCH_TOOL_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
} from "../installer/search-policy.ts";
import { formatLiteralLocate, hasRegexLiteral, listIndexedFiles } from "../literal.ts";
import type { Chunk, ContentType, SearchResult } from "../types.ts";
import {
  DEFAULT_EXPAND_AFTER,
  DEFAULT_EXPAND_BEFORE,
  dedupeResultsByFile,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  resolveChunk,
  SEARCH_RESULT_COUNT,
} from "../utils.ts";
import { registerAuthTool, toolErrorText } from "./auth-tool.ts";
import {
  formatExpandResultsText,
  formatLiteralLocateText,
  formatResultsText,
} from "./format-text.ts";
import { getIndexForRepo, type IndexCache, toolText } from "./index-cache.ts";
import { MiruMcpServer } from "./runtime.ts";

const REPO_DESCRIPTION =
  "`repo` is optional: local path or Git URL (default: the server's directory).";

const BENCHMARK_SKIP_NOTES = {
  local_repo_only: "Benchmark comparisons require a local repo path; git URL repos are skipped.",
  filtered_search:
    "Benchmark comparisons are skipped when search is restricted by include/exclude patterns.",
  limited_locate:
    "Benchmark comparison skipped: locate.limit is global, while rg/grep limits are per file. Omit limit for a valid token and recall comparison.",
  incompatible_literal_baseline:
    "Benchmark comparison skipped: a comparable literal baseline requires rg or compatible grep. Windows findstr does not preserve locate scope, context, or count semantics.",
  regex_or_file_list:
    "Benchmark comparison skipped: regex and file-list locate calls have no equivalent fixed-string rg baseline.",
  grep_timeout:
    "Benchmark Grep baseline timed out; Miru results are still returned. " +
    "Raise MIRU_BENCHMARK_SEARCH_TIMEOUT (seconds) if needed.",
} as const;

type BenchmarkSkipReason = keyof typeof BENCHMARK_SKIP_NOTES;

function withBenchmarkSkippedNote(body: string, reason: BenchmarkSkipReason): string {
  return `${body}\n\n${JSON.stringify({
    benchmark_skipped: reason,
    note: BENCHMARK_SKIP_NOTES[reason],
  })}`;
}

/**
 * Use the source file for final snippet shaping when it is locally available.
 * Index chunks can intentionally split a large declaration; source-backed
 * snippets let the structural guard return a complete declaration instead.
 */
async function loadSnippetSources(
  root: string | null,
  results: SearchResult[],
): Promise<Map<string, Chunk> | undefined> {
  if (!root) {
    return undefined;
  }
  const sources = new Map<string, Chunk>();
  await Promise.all(
    [...new Set(results.map((result) => result.chunk.file_path))].map(async (filePath) => {
      try {
        const content = await Bun.file(join(root, filePath)).text();
        const indexed = results.find((result) => result.chunk.file_path === filePath)?.chunk;
        // Synthetic index entries (for example package entry-point metadata) do
        // not occur verbatim in the source file and must retain their own chunk.
        if (!indexed || !content.includes(indexed.content)) {
          return;
        }
        const lines = content.split("\n");
        sources.set(filePath, {
          content,
          file_path: filePath,
          start_line: 1,
          end_line: lines.length,
          language: indexed.language,
        });
      } catch {
        // A stale index entry is still safe to format from its indexed chunk.
      }
    }),
  );
  return sources;
}

async function persistBenchmarkQuery(
  ...args: Parameters<typeof appendBenchmarkQuery>
): Promise<void> {
  try {
    await appendBenchmarkQuery(...args);
  } catch {
    // History is best-effort; never fail the tool on persist errors.
  }
}

/** Claude Code defers MCP tools behind ToolSearch by default; keep Miru visible next to Grep/Glob/Read, including to subagents. */
const LOAD_UPFRONT_META = { "anthropic/alwaysLoad": true };

export function createMcpServer(
  cache: IndexCache,
  options?: {
    benchmark?: boolean;
    dependencies?: {
      withGrepTimeoutFallback?: typeof withGrepTimeoutFallback;
      benchmarkSearchComparison?: typeof benchmarkSearchComparison;
      benchmarkLocateComparison?: typeof benchmarkLocateComparison;
      selectComparableLiteralSearchTool?: typeof selectComparableLiteralSearchTool;
      readBenchmarkRollup?: typeof readBenchmarkRollup;
    };
  },
): MiruMcpServer {
  const defaultRepo = process.cwd();
  const benchmark = options?.benchmark ?? false;
  const dependencies = options?.dependencies;
  const runWithGrepFallback = dependencies?.withGrepTimeoutFallback ?? withGrepTimeoutFallback;
  const compareSearch = dependencies?.benchmarkSearchComparison ?? benchmarkSearchComparison;
  const compareLocate = dependencies?.benchmarkLocateComparison ?? benchmarkLocateComparison;
  const selectLiteralBaseline =
    dependencies?.selectComparableLiteralSearchTool ?? selectComparableLiteralSearchTool;
  const readRollup = dependencies?.readBenchmarkRollup ?? readBenchmarkRollup;
  const server = new MiruMcpServer(
    {
      name: "miru",
      version: packageJson.version,
    },
    {
      instructions: benchmark ? MCP_BENCHMARK_SERVER_INSTRUCTIONS : MCP_SERVER_INSTRUCTIONS,
    },
  );

  registerAuthTool(server, { onAuthenticated: () => cache.close() });

  server.registerTool(
    "search",
    {
      description: MCP_SEARCH_TOOL_DESCRIPTION,
      _meta: LOAD_UPFRONT_META,
      inputSchema: {
        query: z.string().describe("Natural language or code query."),
        repo: z.string().optional().describe(REPO_DESCRIPTION),
        include: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Gitignore-style globs; only matching files are searched, e.g. ["src/auth/**"]. Same as `locate.include`.',
          ),
        exclude: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("Gitignore-style globs; matching files are skipped. Same as `locate.exclude`."),
        dedupe_by_file: z.boolean().optional().describe("One best hit per file (default true)."),
      },
    },
    async ({ query, repo, include, exclude, dedupe_by_file: dedupeByFile }) => {
      try {
        const source = repo ?? defaultRepo;
        const index = await getIndexForRepo(source, cache);
        const repoRoot = localRepoRoot(source);
        const k = SEARCH_RESULT_COUNT;
        let skip: BenchmarkSkipReason | undefined;
        if (benchmark && (include || exclude)) {
          skip = "filtered_search";
        } else if (benchmark && repoRoot) {
          const comparison = await runWithGrepFallback(() =>
            compareSearch({
              query,
              repoPath: repoRoot,
              index,
              topK: k,
              dedupeByFile: dedupeByFile !== false,
            }),
          );
          if (comparison) {
            const results = comparison.results;
            if (results.length === 0) {
              return toolText("No results found.");
            }
            await persistBenchmarkQuery(recordFromBenchmark(repoRoot, comparison.benchmark));
            const body = formatResultsText(
              formatResults(query, results, {
                repoRoot,
                snippet: true,
                snippetSourceChunks: await loadSnippetSources(index.root, results),
              }),
            );
            return toolText(
              appendAgentBenchmark(body, toAgentBenchmarkSummary(comparison.benchmark)),
            );
          }
          skip = "grep_timeout";
        } else if (benchmark && !repoRoot) {
          skip = "local_repo_only";
        }

        let results = await index.search({ query, topK: k, include, exclude });
        if (dedupeByFile !== false) {
          results = dedupeResultsByFile(results);
        }
        if (results.length === 0) {
          return toolText("No results found.");
        }
        const payload = formatResults(query, results, {
          repoRoot,
          snippet: true,
          snippetSourceChunks: await loadSnippetSources(index.root, results),
        });
        const body = formatResultsText(payload);
        return toolText(skip ? withBenchmarkSkippedNote(body, skip) : body);
      } catch (err) {
        return toolErrorText(err);
      }
    },
  );

  server.registerTool(
    "locate",
    {
      description: MCP_LOCATE_TOOL_DESCRIPTION,
      _meta: LOAD_UPFRONT_META,
      inputSchema: {
        literal: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe(
            "Exact substring, or a regex wrapped in slashes like `/foo\\w+Bar/` or `/bench/i` (ignores case). An array ORs several. Omit and pass `include` to list files.",
          ),
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe("Alias for `literal`."),
        repo: z.string().optional().describe(REPO_DESCRIPTION),
        mode: z
          .enum(["count", "files", "locations", "lines"])
          .optional()
          .describe(
            "count=totals; files=unique paths; locations=path:lines; lines=path:line+text (default).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Cap on hits. Omit for ALL matches (recommended); if n is large use mode=count/files, not Grep.",
          ),
        ignore_case: z.boolean().optional().describe("Case-insensitive (default false)."),
        match_variants: z
          .boolean()
          .optional()
          .describe('Also match other casings, e.g. "rateLimit" finds "rate_limit", "RATE_LIMIT".'),
        include: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Gitignore-style globs; only matching files are searched, e.g. ["apps/**/*.go"].',
          ),
        exclude: z
          .array(z.string().min(1))
          .optional()
          .describe("Gitignore-style globs; matching files are skipped."),
        context_lines: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Context lines around each match (mode=lines only)."),
      },
    },
    async ({ literal, query, repo, ...locateOpts }) => {
      const lit = literal ?? query;
      if (lit == null && !locateOpts.include?.length) {
        return toolErrorText(
          new Error(
            "locate requires `literal` (exact substring or /regex/), or `include` globs to list files.",
          ),
        );
      }
      try {
        const source = repo ?? defaultRepo;
        const index = await getIndexForRepo(source, cache);

        if (lit == null) {
          const listing = listIndexedFiles(index.chunks, locateOpts);
          const body = formatLiteralLocateText(formatLiteralLocate(listing));
          return toolText(benchmark ? withBenchmarkSkippedNote(body, "regex_or_file_list") : body);
        }

        let skip: BenchmarkSkipReason | undefined;
        const repoRoot = localRepoRoot(source);
        if (benchmark && repoRoot && typeof lit === "string") {
          if (locateOpts.mode === "files" || hasRegexLiteral(lit)) {
            skip = "regex_or_file_list";
          } else if (locateOpts.limit != null) {
            skip = "limited_locate";
          } else if (!selectLiteralBaseline()) {
            skip = "incompatible_literal_baseline";
          }
          if (!skip) {
            const comparison = await runWithGrepFallback(() =>
              compareLocate({
                literal: lit,
                repoPath: repoRoot,
                index,
                locate: locateOpts,
              }),
            );
            if (comparison) {
              await persistBenchmarkQuery(recordFromAgentSummary(repoRoot, comparison.benchmark));
              const body = formatLiteralLocateText(comparison.payload);
              return toolText(appendAgentBenchmark(body, comparison.benchmark));
            }
            skip = "grep_timeout";
          }
        } else if (benchmark && !repoRoot) {
          skip = "local_repo_only";
        }

        const result = index.locateLiteral(lit, locateOpts);
        const payload = formatLiteralLocate(result);
        const body = formatLiteralLocateText(payload);
        return toolText(skip ? withBenchmarkSkippedNote(body, skip) : body);
      } catch (err) {
        return toolErrorText(err);
      }
    },
  );

  server.registerTool(
    "expand",
    {
      description: MCP_EXPAND_TOOL_DESCRIPTION,
      _meta: LOAD_UPFRONT_META,
      inputSchema: {
        file_path: z.string().describe("Path from a search hit."),
        anchor_line: z
          .number()
          .int()
          .describe("Line from the hit (`anchor_line` if truncated, else `start_line`)."),
        repo: z.string().optional().describe(REPO_DESCRIPTION),
        before: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Extra chunks before (default ${DEFAULT_EXPAND_BEFORE}).`),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Extra chunks after (default ${DEFAULT_EXPAND_AFTER}).`),
      },
    },
    async ({ file_path: filePath, anchor_line: anchorLine, repo, before, after }) => {
      try {
        const source = repo ?? defaultRepo;
        const index = await getIndexForRepo(source, cache);
        const repoRoot = localRepoRoot(source);
        const beforeCount = before ?? DEFAULT_EXPAND_BEFORE;
        const afterCount = after ?? DEFAULT_EXPAND_AFTER;
        const { anchor, chunks: expanded } = expandChunksAtLine(
          index.chunks,
          filePath,
          anchorLine,
          repoRoot,
          beforeCount,
          afterCount,
        );
        if (!anchor) {
          return toolText(
            `No chunk found at ${filePath}:${anchorLine}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        return toolText(
          formatExpandResultsText(
            formatExpandResults(filePath, anchorLine, anchor, expanded, {
              repoRoot,
              before: beforeCount,
              after: afterCount,
            }),
          ),
        );
      } catch (err) {
        return toolErrorText(err);
      }
    },
  );

  server.registerTool(
    "find_related",
    {
      description: MCP_FIND_RELATED_TOOL_DESCRIPTION,
      _meta: LOAD_UPFRONT_META,
      inputSchema: {
        file_path: z.string().describe("Path from a search hit."),
        anchor_line: z
          .number()
          .int()
          .describe("Line from the hit (`anchor_line` if truncated, else `start_line`)."),
        repo: z.string().optional().describe(REPO_DESCRIPTION),
      },
    },
    async ({ file_path: filePath, anchor_line: anchorLine, repo }) => {
      try {
        const source = repo ?? defaultRepo;
        const index = await getIndexForRepo(source, cache);
        const repoRoot = localRepoRoot(source);
        const chunk = resolveChunk(index.chunks, filePath, anchorLine, repoRoot);
        if (!chunk) {
          return toolText(
            `No chunk found at ${filePath}:${anchorLine}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        const results = await index.findRelated(chunk, SEARCH_RESULT_COUNT);
        if (results.length === 0) {
          return toolText(`No related chunks found for ${filePath}:${anchorLine}.`);
        }
        return toolText(
          formatResultsText(
            formatResults(`Chunks related to ${filePath}:${anchorLine}`, results, {
              repoRoot,
              snippet: true,
              snippetSourceChunks: await loadSnippetSources(index.root, results),
            }),
          ),
        );
      } catch (err) {
        return toolErrorText(err);
      }
    },
  );

  if (benchmark) {
    server.registerTool(
      "read_benchmark",
      {
        description: MCP_READ_BENCHMARK_TOOL_DESCRIPTION,
        inputSchema: {
          repo: z
            .string()
            .optional()
            .describe(
              "Optional local repo path or git URL to filter the rollup. Omit for overall totals.",
            ),
        },
      },
      async ({ repo }) => {
        try {
          const rollup = await readRollup({ repo });
          return toolText(JSON.stringify(rollup));
        } catch (err) {
          return toolText(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  return server;
}

export type { ContentType };
