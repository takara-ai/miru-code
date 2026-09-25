import { type ContentType, defaultContentTypes } from "../types.ts";
import { IndexCache } from "./index-cache.ts";
import { createMcpServer } from "./server.ts";
import { StdioTransport } from "./stdio.ts";

export async function serveMcp(options: {
  ref?: string | null;
  content?: ContentType[];
  benchmark?: boolean;
}): Promise<void> {
  // TEMPORARY: see src/cli.ts and src/mcp/stdio.ts's matching diag blocks.
  const diag = process.env.MIRU_COLD_START_DIAG === "1";
  if (diag) {
    process.stderr.write(`[serve-diag] serveMcp entered @ ${Date.now()}\n`);
  }
  const cache = new IndexCache(options.content ?? defaultContentTypes(), options.ref ?? null);
  const server = createMcpServer(cache, { benchmark: options.benchmark ?? false });
  const transport = new StdioTransport();
  if (diag) {
    process.stderr.write(`[serve-diag] about to call server.connect @ ${Date.now()}\n`);
  }
  await server.connect(transport);
  if (diag) {
    process.stderr.write(`[serve-diag] server.connect resolved @ ${Date.now()}\n`);
  }
}
