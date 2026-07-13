import * as z from "zod";
import packageJson from "../../package.json";
import { attachSearchBenchmark, benchmarkSearchComparison } from "../benchmark/compare.ts";
import {
  appendBenchmarkQuery,
  readBenchmarkRollup,
  recordFromAgentSummary,
  recordFromBenchmark,
} from "../benchmark/history.ts";
import { attachLocateBenchmark, benchmarkLocateComparison } from "../benchmark/locate-compare.ts";
import {
  MCP_BENCHMARK_SERVER_INSTRUCTIONS,
  MCP_EXPAND_TOOL_DESCRIPTION,
  MCP_FIND_RELATED_TOOL_DESCRIPTION,
  MCP_LOCATE_TOOL_DESCRIPTION,
  MCP_READ_BENCHMARK_TOOL_DESCRIPTION,
  MCP_SEARCH_TOOL_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
} from "../installer/search-policy.ts";
import { formatLiteralLocate, type LiteralMode } from "../literal.ts";
import type { ContentType } from "../types.ts";
import {
  clampMcpTopK,
  DEFAULT_MCP_TOP_K,
  dedupeResultsByFile,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  MAX_MCP_TOP_K,
  resolveChunk,
} from "../utils.ts";
import { getIndexForRepo, type IndexCache, toolText } from "./index-cache.ts";
import { MiruMcpServer } from "./runtime.ts";

const REPO_DESCRIPTION =
  "https:// or http:// git URL (e.g. https://github.com/org/repo) or local directory path to index and search. " +
  "Pass the project root for local workspaces. " +
  "The index is built on the first tool call and cached for the session.";

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

        if (benchmark && repoRoot) {
          const comparison = await benchmarkSearchComparison({
            query,
            repoPath: repoRoot,
            index,
            topK: k,
          });
          let results = comparison.results;
          if (dedupeByFile !== false) {
            results = dedupeResultsByFile(results);
          }
          if (results.length === 0) {
            return toolText(JSON.stringify({ error: "No results found." }));
          }
          try {
            await appendBenchmarkQuery(recordFromBenchmark(query, repoRoot, comparison.benchmark));
          } catch {
            // History is best-effort; never fail the search on persist errors.
          }
          return toolText(
            JSON.stringify(
              attachSearchBenchmark(
                formatResults(query, results, { repoRoot, snippet: true }),
                comparison.benchmark,
              ),
            ),
          );
        }

        let results = await index.search({ query, topK: k });
        if (dedupeByFile !== false) {
          results = dedupeResultsByFile(results);
        }
        if (results.length === 0) {
          return toolText(JSON.stringify({ error: "No results found." }));
        }
        return toolText(JSON.stringify(formatResults(query, results, { repoRoot, snippet: true })));
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
          .string()
          .min(1)
          .describe("Exact substring to find (env var, symbol, error code, quoted text)."),
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
      },
    },
    async ({ literal, repo, mode, limit, ignore_case: ignoreCase }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const locateOpts = {
          mode: (mode as LiteralMode | undefined) ?? "lines",
          ...(limit != null ? { limit } : {}),
          ignore_case: ignoreCase,
        };

        if (benchmark) {
          const repoRoot = localRepoRoot(repo);
          if (repoRoot) {
            const comparison = await benchmarkLocateComparison({
              literal,
              repoPath: repoRoot,
              index,
              locate: locateOpts,
            });
            try {
              await appendBenchmarkQuery(
                recordFromAgentSummary(literal, repoRoot, comparison.benchmark),
              );
            } catch {
              // History is best-effort; never fail locate on persist errors.
            }
            return toolText(
              JSON.stringify(attachLocateBenchmark(comparison.payload, comparison.benchmark)),
            );
          }
        }

        const result = index.locateLiteral(literal, locateOpts);
        return toolText(JSON.stringify(formatLiteralLocate(result)));
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
          .describe("Extra chunks before the anchor (default 1)."),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Extra chunks after the anchor (default 1)."),
      },
    },
    async ({ file_path: filePath, anchor_line: anchorLine, repo, before, after }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
        const beforeCount = before ?? 1;
        const afterCount = after ?? 1;
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
          JSON.stringify(
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
          return toolText(
            JSON.stringify({ error: `No related chunks found for ${filePath}:${anchorLine}.` }),
          );
        }
        return toolText(
          JSON.stringify(
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
              "Optional local repo path or git URL to filter the rollup. Omit for all saved queries.",
            ),
          recent_limit: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe("Include this many recent rows (default 0). Keep 0 unless needed."),
        },
      },
      async ({ repo, recent_limit: recentLimit }) => {
        try {
          const rollup = await readBenchmarkRollup({
            repo,
            recentLimit: recentLimit ?? 0,
          });
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
