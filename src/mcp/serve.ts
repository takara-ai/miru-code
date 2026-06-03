import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentType } from "../types.ts";
import { isGitUrl } from "../utils.ts";
import { IndexCache } from "./index-cache.ts";
import { createMcpServer } from "./server.ts";

export async function serveMcp(options: {
  path?: string | null;
  ref?: string | null;
  content?: ContentType[];
}): Promise<void> {
  const cache = new IndexCache(options.content ?? ["code"]);
  const defaultSource = options.path ?? resolve(process.cwd());

  void cache.get(defaultSource, options.ref).catch(() => undefined);
  if (!isGitUrl(defaultSource)) {
    cache.startWatcher(defaultSource);
  }

  const server = createMcpServer(cache, defaultSource);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
