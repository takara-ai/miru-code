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
import { formatLiteralLocate } from "../literal.ts";
import type { ContentType } from "../types.ts";
import {
  clampMcpTopK,
  DEFAULT_EXPAND_AFTER,
  DEFAULT_EXPAND_BEFORE,
  DEFAULT_MCP_TOP_K,
  dedupeResultsByFile,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  MAX_MCP_TOP_K,
  resolveChunk,
} from "../utils.ts";
import { registerAuthTool } from "./auth-tool.ts";
import {
  formatExpandResultsText,
  formatLiteralLocateText,
  formatResultsText,
} from "./format-text.ts";
import { getIndexForRepo, type IndexCache, toolText } from "./index-cache.ts";
import { MiruMcpServer } from "./runtime.ts";

const REPO_DESCRIPTION =
  "https:// or http:// git URL (e.g. https://github.com/org/repo) or local directory path to index and search. " +
  "Pass the project root for local workspaces. " +
  "The index is built on the first tool call and cached for the session.";

const BENCHMARK_SKIP_NOTES = {
  local_repo_only: "Benchmark comparisons require a local repo path; git URL repos are skipped.",
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

async function persistBenchmarkQuery(
  ...args: Parameters<typeof appendBenchmarkQuery>
): Promise<void> {
  try {
    await appendBenchmarkQuery(...args);
  } catch {
    // History is best-effort; never fail the tool on persist errors.
  }
}

export function createMcpServer(
  cache: IndexCache,
  options?: { benchmark?: boolean },
): MiruMcpServer {
  const benchmark = options?.benchmark ?? false;
  const server = new MiruMcpServer(
    {
      name: "miru",
      version: packageJson.version,
    },
    {
      instructions: benchmark ? MCP_BENCHMARK_SERVER_INSTRUCTIONS : MCP_SERVER_INSTRUCTIONS,
    },
  );

  registerAuthTool(server);

  server.registerTool(
    "search",
    {
      description: `${MCP_SEARCH_TOOL_DESCRIPTION} Indexes \`repo\` on first call; later calls reuse the session cache.`,
      inputSchema: {
        query: z
          .string()
          .describe(
            "Natural language or code query — your default for all code search in this repo.",
          ),
        repo: z.string().describe(REPO_DESCRIPTION),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(MAX_MCP_TOP_K)
          .optional()
          .describe(`Number of results (default ${DEFAULT_MCP_TOP_K}, max ${MAX_MCP_TOP_K}).`),
        dedupe_by_file: z
          .boolean()
          .optional()
          .describe("Keep only the best hit per file (default true)."),
      },
    },
    async ({ query, repo, top_k: topK, dedupe_by_file: dedupeByFile }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
        const k = clampMcpTopK(topK);

        let skip: BenchmarkSkipReason | undefined;
        if (benchmark && repoRoot) {
          const comparison = await withGrepTimeoutFallback(() =>
            benchmarkSearchComparison({
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
              formatResults(query, results, { repoRoot, snippet: true }),
            );
            return toolText(
              appendAgentBenchmark(body, toAgentBenchmarkSummary(comparison.benchmark)),
            );
          }
          skip = "grep_timeout";
        } else if (benchmark && !repoRoot) {
          skip = "local_repo_only";
        }

        let results = await index.search({ query, topK: k });
        if (dedupeByFile !== false) {
          results = dedupeResultsByFile(results);
        }
        if (results.length === 0) {
          return toolText("No results found.");
        }
        const payload = formatResults(query, results, { repoRoot, snippet: true });
        const body = formatResultsText(payload);
        return toolText(skip ? withBenchmarkSkippedNote(body, skip) : body);
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "locate",
    {
      description: MCP_LOCATE_TOOL_DESCRIPTION,
      inputSchema: {
        literal: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "Exact substring to find (env var, symbol, error code, quoted text). " +
              "Pass an array to OR-match several substrings (e.g. spelling/casing variants) in one call.",
          ),
        repo: z.string().describe(REPO_DESCRIPTION),
        mode: z
          .enum(["count", "locations", "lines"])
          .optional()
          .describe(
            "count=totals only; locations=path:line; lines=path:line+text (default). Prefer count/locations when possible.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Optional cap on returned hits. Omit to return ALL matches (recommended). Do not fall back to Grep if n is large — use mode=count or locations instead.",
          ),
        ignore_case: z.boolean().optional().describe("Case-insensitive match (default false)."),
        match_variants: z
          .boolean()
          .optional()
          .describe(
            'Also match other ways the same word might be written in code, e.g. "rateLimit" also finds "rate_limit" and "RATE_LIMIT".',
          ),
        include: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Gitignore-style glob patterns; only matching files are searched (e.g. "apps/tldr/**/*.go").',
          ),
        exclude: z
          .array(z.string().min(1))
          .optional()
          .describe("Gitignore-style glob patterns; matching files are skipped."),
        context_lines: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Lines of context before/after each match, like `grep -C` (mode=lines only)."),
      },
    },
    async ({ literal, repo, ...locateOpts }) => {
      try {
        const index = await getIndexForRepo(repo, cache);

        let skip: BenchmarkSkipReason | undefined;
        const repoRoot = localRepoRoot(repo);
        if (benchmark && repoRoot && typeof literal === "string") {
          const comparison = await withGrepTimeoutFallback(() =>
            benchmarkLocateComparison({
              literal,
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
        } else if (benchmark && !repoRoot) {
          skip = "local_repo_only";
        }

        const result = index.locateLiteral(literal, locateOpts);
        const payload = formatLiteralLocate(result);
        const body = formatLiteralLocateText(payload);
        return toolText(skip ? withBenchmarkSkippedNote(body, skip) : body);
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "expand",
    {
      description: MCP_EXPAND_TOOL_DESCRIPTION,
      inputSchema: {
        file_path: z
          .string()
          .describe("Path from a search hit (`file_path` or `absolute_path` for local repos)."),
        anchor_line: z
          .number()
          .int()
          .describe("Line from the search hit (`anchor_line` when truncated, else `start_line`)."),
        repo: z.string().describe(REPO_DESCRIPTION),
        before: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Extra chunks before the anchor (default ${DEFAULT_EXPAND_BEFORE}).`),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Extra chunks after the anchor (default ${DEFAULT_EXPAND_AFTER}).`),
      },
    },
    async ({ file_path: filePath, anchor_line: anchorLine, repo, before, after }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
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
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "find_related",
    {
      description: MCP_FIND_RELATED_TOOL_DESCRIPTION,
      inputSchema: {
        file_path: z
          .string()
          .describe("Path from a search hit (`file_path` or `absolute_path` for local repos)."),
        anchor_line: z
          .number()
          .int()
          .describe("Line from the search hit (`anchor_line` when truncated, else `start_line`)."),
        repo: z.string().describe(REPO_DESCRIPTION),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(MAX_MCP_TOP_K)
          .optional()
          .describe(
            `Number of similar chunks to return (default ${DEFAULT_MCP_TOP_K}, max ${MAX_MCP_TOP_K}).`,
          ),
      },
    },
    async ({ file_path: filePath, anchor_line: anchorLine, repo, top_k: topK }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
        const chunk = resolveChunk(index.chunks, filePath, anchorLine, repoRoot);
        if (!chunk) {
          return toolText(
            `No chunk found at ${filePath}:${anchorLine}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        const results = await index.findRelated(chunk, clampMcpTopK(topK));
        if (results.length === 0) {
          return toolText(`No related chunks found for ${filePath}:${anchorLine}.`);
        }
        return toolText(
          formatResultsText(
            formatResults(`Chunks related to ${filePath}:${anchorLine}`, results, {
              repoRoot,
              snippet: true,
            }),
          ),
        );
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
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
          const rollup = await readBenchmarkRollup({ repo });
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
