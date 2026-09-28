import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { IndexCache } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { computeSourceCacheKey } from "../src/utils.ts";
import { MemoryTransport } from "./helpers/mcp-memory-transport.ts";
import { unitVector } from "./test-helpers.ts";

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-locate-alias",
    dimensions: 8,
    async embedDocuments(texts: string[]) {
      return texts.map((_, i) => unitVector(8, i % 8));
    },
    async embedQuery(text: string) {
      return unitVector(8, text.length % 8);
    },
  };
}

/** Build an MCP server whose cache already holds a pre-built index (skips real embeddings). */
async function serverWithSeededIndex(root: string): Promise<ReturnType<typeof createMcpServer>> {
  const embeddings = mockEmbeddings();
  const built = await createIndexFromPath(root, embeddings, ["code"], root);
  const index = new MiruIndex({
    embeddings,
    bm25Index: built.bm25,
    semanticIndex: built.semantic,
    chunks: built.chunks,
    embeddingModel: embeddings.model,
    root,
    content: ["code"],
  });

  const cache = new IndexCache(["code"]);
  const cacheKey = computeSourceCacheKey(root);
  const entry = (
    cache as unknown as {
      ensureEntry(key: string, source?: string): { index: MiruIndex | null; task: unknown };
    }
  ).ensureEntry(cacheKey, root);
  entry.index = index;
  entry.task = Promise.resolve(index);

  return createMcpServer(cache);
}

async function callLocate(
  server: ReturnType<typeof createMcpServer>,
  args: Record<string, unknown>,
): Promise<string> {
  const transport = new MemoryTransport([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "locate", arguments: args } },
  ]);
  await server.connect(transport);
  const call = transport.responseFor(2);
  if (!call || !("result" in call)) {
    throw new Error("missing tools/call response");
  }
  const result = call.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

test("locate resolves `query` as an alias for `literal`", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-locate-alias-"));
  try {
    await writeFile(
      join(root, "app.ts"),
      "export const DATABASE_URL = process.env.DATABASE_URL;\n",
      "utf-8",
    );
    const server = await serverWithSeededIndex(root);

    const viaQuery = await callLocate(server, { query: "DATABASE_URL", repo: root });
    expect(viaQuery).toContain("DATABASE_URL");
    expect(viaQuery).not.toContain("No results");

    const viaLiteral = await callLocate(server, { literal: "DATABASE_URL", repo: root });
    expect(viaQuery).toBe(viaLiteral);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locate without `literal` or `query` fails with a clear error, not a schema crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-locate-alias-empty-"));
  try {
    await writeFile(join(root, "app.ts"), "export const X = 1;\n", "utf-8");
    const server = await serverWithSeededIndex(root);

    const text = await callLocate(server, { repo: root });
    expect(text).toContain("literal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
