/** Instrumented production Miru server; fixture backend is explicitly a behavior-only test double. */
import { appendFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadStoredCredentials } from "../../src/credentials.ts";
import { walkFiles } from "../../src/index/file-walker.ts";
import { detectLanguage, getExtensions, readFileText } from "../../src/index/files.ts";
import { locateLiteral } from "../../src/literal.ts";
import { IndexCache } from "../../src/mcp/index-cache.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { type JsonRpcMessage, StdioTransport } from "../../src/mcp/stdio.ts";
import { type Chunk, defaultContentTypes, type SearchResult } from "../../src/types.ts";

export function lexicalWords(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9]+/g) ?? [],
  );
}

export async function fixtureIndex(root: string) {
  const chunks: Chunk[] = [];
  for await (const path of walkFiles(root, getExtensions(defaultContentTypes()))) {
    const lines = (await readFileText(path)).split("\n");
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    for (let start = 0; start < lines.length; start += 20)
      chunks.push({
        file_path: relative,
        start_line: start + 1,
        end_line: Math.min(start + 20, lines.length),
        content: lines.slice(start, start + 20).join("\n"),
        language: detectLanguage(path),
      });
  }
  const rank = (query: string, topK: number, omit?: string): SearchResult[] => {
    const terms = lexicalWords(query);
    return chunks
      .filter((c) => c.file_path !== omit)
      .map((chunk) => ({
        chunk,
        score: [...lexicalWords(`${chunk.file_path} ${chunk.content}`)].filter((word) =>
          terms.has(word),
        ).length,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.file_path.localeCompare(b.chunk.file_path))
      .slice(0, topK);
  };
  return {
    root,
    chunks,
    embeddingModel: "fixture-lexical",
    supportsCodeRanking: false,
    locateLiteral: (literal: string | string[], options: Parameters<typeof locateLiteral>[2]) =>
      locateLiteral(chunks, literal, options),
    search: async ({ query, topK = 5 }: { query: string; topK?: number }) => rank(query, topK),
    findRelated: async (chunk: Chunk, topK = 5) => rank(chunk.content, topK, chunk.file_path),
  };
}

async function main() {
  const root = realpathSync(process.cwd());
  process.env.MIRU_WORKSPACE_ROOT = root;
  const backend = process.env.MIRU_EVAL_BACKEND ?? "real";
  const fault = process.env.MIRU_EVAL_FAULT ?? "none";
  const log = process.env.MIRU_EVAL_MCP_LOG;
  const audit = (value: unknown) => {
    if (log)
      appendFileSync(
        log,
        `${JSON.stringify({ at: new Date().toISOString(), ...(value as object) })}\n`,
        { mode: 0o600 },
      );
  };
  let cached: ReturnType<typeof fixtureIndex> | undefined;
  if (backend === "real") await loadStoredCredentials();
  const cache =
    backend === "fixture"
      ? ({
          get: async () => {
            cached ??= fixtureIndex(root);
            return cached;
          },
          close() {},
        } as unknown as IndexCache)
      : new IndexCache();
  const server = createMcpServer(cache);
  const calls = new Map<unknown, string>();
  const initializations = new Map<unknown, unknown>();
  const send = async (message: object) => {
    await Bun.write(Bun.stdout, `${JSON.stringify(message)}\n`);
  };
  class AuditTransport extends StdioTransport {
    override async start() {
      const forward = this.onmessage;
      this.onmessage = async (message: JsonRpcMessage) => {
        if ("method" in message && "id" in message && message.method === "initialize")
          initializations.set(message.id, (message.params as { clientInfo?: unknown })?.clientInfo);
        if ("method" in message && message.method === "tools/call" && "id" in message) {
          const params = message.params as { name: string; arguments?: Record<string, unknown> };
          calls.set(message.id, params.name);
          audit({
            direction: "request",
            id: message.id,
            tool: params.name,
            args: params.arguments ?? {},
          });
          const repo = params.arguments?.repo;
          let error: string | undefined;
          if (typeof repo === "string") {
            try {
              if (realpathSync(resolve(repo)) !== root)
                error = "Evaluation tools may only inspect the fixture repository.";
            } catch {
              error = "Evaluation tools may only inspect the fixture repository.";
            }
          }
          // Never open a browser or change real credentials from an evaluated model.
          if (params.name === "auth")
            error =
              "Authentication unavailable in this controlled test. Report the authentication problem and stop retrying.";
          else if (fault === "auth")
            error = "Miru credentials are invalid. Call this server's auth tool to recover.";
          else if (fault === "server")
            error =
              "Miru server unavailable: simulated upstream failure. Report this error and stop retrying.";
          if (error) {
            const result = { content: [{ type: "text", text: error }], isError: true };
            audit({ direction: "response", id: message.id, tool: params.name, result });
            await send({ jsonrpc: "2.0", id: message.id, result });
            return;
          }
        }
        await forward?.(message);
      };
      return super.start();
    }
  }
  const transport = new AuditTransport({
    writeText: async (text) => {
      const message = JSON.parse(text);
      if (initializations.has(message.id) && message.result?.serverInfo)
        audit({
          direction: "lifecycle",
          event: "initialized",
          backend,
          serverInfo: message.result.serverInfo,
          clientInfo: initializations.get(message.id),
        });
      if (calls.has(message.id))
        audit({
          direction: "response",
          id: message.id,
          tool: calls.get(message.id),
          result: message.result,
          error: message.error,
        });
      return Bun.write(Bun.stdout, text);
    },
  });
  await server.connect(transport);
}

if (import.meta.main) await main();
