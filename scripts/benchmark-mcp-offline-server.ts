/**
 * Stdio MCP server for benchmarks: the real Miru tool definitions, descriptions, instructions and
 * output formatting, over chunks built offline from this repo (no embeddings, no credentials).
 * `search`/`find_related` return nothing; the benchmarks only drive `locate`.
 *
 * Launched by benchmark-regex-glob-live.ts through `claude --mcp-config`.
 */
import { locateLiteral } from "../src/literal.ts";
import type { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { StdioTransport } from "../src/mcp/stdio.ts";
import { chunkRepoOffline, ROOT } from "./benchmark-regex-glob-lib.ts";

let indexPromise: Promise<unknown> | undefined;

function getIndex(): Promise<unknown> {
  indexPromise ??= chunkRepoOffline().then((chunks) => ({
    root: ROOT,
    chunks,
    locateLiteral: (literal: string | string[], options: object) =>
      locateLiteral(chunks, literal, options),
    search: async () => [],
    findRelated: async () => [],
  }));
  return indexPromise;
}

const server = createMcpServer({ get: getIndex } as unknown as IndexCache);
await server.connect(new StdioTransport());
