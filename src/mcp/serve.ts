import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentType } from "../types.ts";
import { IndexCache } from "./index-cache.ts";
import { createMcpServer } from "./server.ts";

export async function serveMcp(options: {
  ref?: string | null;
  content?: ContentType[];
}): Promise<void> {
  const cache = new IndexCache(options.content ?? ["code"], options.ref ?? null);
  const server = createMcpServer(cache);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
