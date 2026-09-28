import { type ContentType, defaultContentTypes } from "../types.ts";
import { IndexCache } from "./index-cache.ts";
import { createMcpServer } from "./server.ts";
import { StdioTransport } from "./stdio.ts";

export async function serveMcp(options: {
  ref?: string | null;
  content?: ContentType[];
  benchmark?: boolean;
}): Promise<void> {
  const cache = new IndexCache(options.content ?? defaultContentTypes(), options.ref ?? null);
  const server = createMcpServer(cache, { benchmark: options.benchmark ?? false });
  const transport = new StdioTransport();
  await server.connect(transport);
}
