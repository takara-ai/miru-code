import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { ContentType } from "../types.ts";
import { formatResults, resolveChunk } from "../utils.ts";
import { getIndexForRepo, type IndexCache, toolText } from "./index-cache.ts";

const REPO_DESCRIPTION =
  "https:// or http:// git URL (e.g. https://github.com/org/repo) or local directory path to index and search. " +
  "Required when no default index was configured at startup. " +
  "The index is cached after the first call, so repeat queries are fast.";

const SERVER_INSTRUCTIONS =
  "Instant code search for any local or remote git repository. " +
  "Call `search` to find relevant code; call `find_related` on a result to discover similar code elsewhere. " +
  "When working in a local project, pass the project root as `repo`. " +
  "For remote repos, pass an explicit https:// URL. Never guess or infer URLs. " +
  "Prefer these tools over Grep, Glob, or Read for any question about how code works.";

export function createMcpServer(cache: IndexCache, defaultSource: string | null = null): McpServer {
  const server = new McpServer(
    {
      name: "miru",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Search a codebase with a natural-language or code query. " +
        "Pass a git URL or local path as `repo` to index it on demand; indexes are cached for the session.",
      inputSchema: {
        query: z.string().describe("Natural language or code query."),
        repo: z.string().nullable().optional().describe(REPO_DESCRIPTION),
        top_k: z.number().int().min(1).optional().describe("Number of results to return."),
      },
    },
    async ({ query, repo, top_k: topK }) => {
      try {
        const index = await getIndexForRepo(repo ?? null, defaultSource, cache);
        const results = await index.search({ query, topK: topK ?? 5 });
        if (results.length === 0) {
          return toolText(JSON.stringify({ error: "No results found." }));
        }
        return toolText(JSON.stringify(formatResults(query, results)));
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "find_related",
    {
      description:
        "Find code chunks semantically similar to a specific location in a file. " +
        "Use after `search` to explore related implementations or callers.",
      inputSchema: {
        file_path: z
          .string()
          .describe(
            "Path to the file as stored in the index (use file_path from a search result).",
          ),
        line: z.number().int().describe("Line number (1-indexed)."),
        repo: z.string().nullable().optional().describe(REPO_DESCRIPTION),
        top_k: z.number().int().min(1).optional().describe("Number of similar chunks to return."),
      },
    },
    async ({ file_path: filePath, line, repo, top_k: topK }) => {
      try {
        const index = await getIndexForRepo(repo ?? null, defaultSource, cache);
        const chunk = resolveChunk(index.chunks, filePath, line);
        if (!chunk) {
          return toolText(
            `No chunk found at ${filePath}:${line}. Make sure the file is indexed and the line number is within a known chunk.`,
          );
        }
        const results = await index.findRelated(chunk, topK ?? 5);
        if (results.length === 0) {
          return toolText(
            JSON.stringify({ error: `No related chunks found for ${filePath}:${line}.` }),
          );
        }
        return toolText(
          JSON.stringify(formatResults(`Chunks related to ${filePath}:${line}`, results)),
        );
      } catch (err) {
        return toolText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

export type { ContentType };
