import * as z from "zod";
import packageJson from "../../package.json";
import {
  MCP_EXPAND_TOOL_DESCRIPTION,
  MCP_FIND_RELATED_TOOL_DESCRIPTION,
  MCP_SEARCH_TOOL_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
} from "../installer/search-policy.ts";
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

export function createMcpServer(cache: IndexCache): MiruMcpServer {
  const server = new MiruMcpServer(
    {
      name: "miru",
      version: packageJson.version,
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "search",
    {
      description: `${MCP_SEARCH_TOOL_DESCRIPTION} Indexes \`repo\` on first call; later calls reuse the session cache.`,
      inputSchema: {
        query: z.string().describe(
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
        let results = await index.search({ query, topK: clampMcpTopK(topK) });
        if (dedupeByFile !== false) {
          results = dedupeResultsByFile(results);
        }
        if (results.length === 0) {
          return toolText(JSON.stringify({ error: "No results found." }));
        }
        const repoRoot = localRepoRoot(repo);
        return toolText(JSON.stringify(formatResults(query, results, { repoRoot, snippet: true })));
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
        line: z
          .number()
          .int()
          .describe(
            "Line from the hit: `anchor_line` when truncated, otherwise `start_line` (1-indexed).",
          ),
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
    async ({ file_path: filePath, line, repo, before, after }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
        const beforeCount = before ?? 1;
        const afterCount = after ?? 1;
        const { anchor, chunks: expanded } = expandChunksAtLine(
          index.chunks,
          filePath,
          line,
          repoRoot,
          beforeCount,
          afterCount,
        );
        if (!anchor) {
          return toolText(
            `No chunk found at ${filePath}:${line}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        return toolText(
          JSON.stringify(
            formatExpandResults(filePath, line, anchor, expanded, {
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
        line: z
          .number()
          .int()
          .describe(
            "Line from the hit: `anchor_line` when truncated, otherwise `start_line` (1-indexed).",
          ),
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
    async ({ file_path: filePath, line, repo, top_k: topK }) => {
      try {
        const index = await getIndexForRepo(repo, cache);
        const repoRoot = localRepoRoot(repo);
        const chunk = resolveChunk(index.chunks, filePath, line, repoRoot);
        if (!chunk) {
          return toolText(
            `No chunk found at ${filePath}:${line}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        const results = await index.findRelated(chunk, clampMcpTopK(topK));
        if (results.length === 0) {
          return toolText(
            JSON.stringify({ error: `No related chunks found for ${filePath}:${line}.` }),
          );
        }
        return toolText(
          JSON.stringify(
            formatResults(`Chunks related to ${filePath}:${line}`, results, {
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

  return server;
}

export type { ContentType };
