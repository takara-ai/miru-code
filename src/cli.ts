#!/usr/bin/env bun
import { resolve } from "node:path";
import { type AgentId, writeAgentFile } from "./agents.ts";
import { clearCache } from "./cache.ts";
import { loadEnvFiles } from "./env-files.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import type { ContentType } from "./types.ts";
import { formatResults, isGitUrl, resolveChunk, resolveContent } from "./utils.ts";

loadEnvFiles();

const CLI_COMMANDS = new Set(["search", "find-related", "init", "clear", "-h", "--help"]);

const AGENTS = new Set<AgentId>(["claude", "copilot", "cursor", "gemini", "kiro", "opencode"]);

function parseContentArgv(argv: string[]): { content: ContentType[]; rest: string[] } {
  const rest: string[] = [];
  const content: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--content") {
      i++;
      while (i < argv.length) {
        const value = argv[i];
        if (value === undefined || value.startsWith("-")) {
          i--;
          break;
        }
        content.push(value);
        i++;
      }
      continue;
    }
    if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { content: resolveContent(content.length > 0 ? content : ["code"]), rest };
}

function parseTopK(argv: string[]): { topK: number; rest: string[] } {
  const rest: string[] = [];
  let topK = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-k" || arg === "--top-k") {
      const raw = argv[++i];
      if (raw) {
        topK = Number(raw);
      }
      continue;
    }
    if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { topK: Number.isFinite(topK) && topK >= 1 ? Math.floor(topK) : 5, rest };
}

async function runSearch(
  path: string,
  query: string,
  topK: number,
  content: ContentType[],
): Promise<void> {
  const index = await MiruIndex.fromSource(path, content);
  await index.saveToDefaultCache(path);
  const results = await index.search({ query, topK });
  const out =
    results.length > 0 ? formatResults(query, results) : { error: "No results found." as const };
  console.log(JSON.stringify(out));
}

async function runFindRelated(
  path: string,
  filePath: string,
  line: number,
  topK: number,
  content: ContentType[],
): Promise<void> {
  const index = await MiruIndex.fromSource(path, content);
  const chunk = resolveChunk(index.chunks, filePath, line);
  if (!chunk) {
    console.error(`No chunk found at ${filePath}:${line}.`);
    process.exit(1);
  }
  const results = await index.findRelated(chunk, topK);
  const label = `Chunks related to ${filePath}:${line}`;
  const out =
    results.length > 0
      ? formatResults(label, results)
      : { error: `No related chunks found for ${filePath}:${line}.` };
  console.log(JSON.stringify(out));
  await index.saveToDefaultCache(path);
}

async function runInit(agent: AgentId, force: boolean): Promise<void> {
  const dest = await writeAgentFile(agent, { force });
  console.log(`Created ${dest}`);
}

async function runClear(path: string): Promise<void> {
  await clearCache(path);
  console.log(`Cleared cached index for: ${path}`);
}

function printHelp(): void {
  console.log(`Miru (見る) — hybrid code search (Bun + TypeScript + Takara)

CLI:
  miru search <query> [path] [-k N] [--content code|docs|config|all]
  miru find-related <file_path> <line> [path] [-k N] [--content ...]
  miru init [--agent cursor] [--force]
  miru clear [path]

MCP server (default when no CLI subcommand):
  miru
  miru [path] [--ref BRANCH] [--content code ...]

  With no path, indexes the process working directory (Cursor sets this to your workspace).

Examples:
  miru search "auth middleware" ./src
  miru find-related src/auth.ts 42 .

Environment:
  TAKARA_API_KEY / OPENAI_API_KEY / MIRU_OPENAI_API_KEY   Takara bearer token
  MIRU_OPENAI_BASE_URL                                    Default: infer.dev.takara.ai
`);
}

async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === "-h" || command === "--help" || command === undefined) {
    printHelp();
    return;
  }

  if (command === "init") {
    let agent: AgentId = "claude";
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--force") {
        force = true;
      } else if ((arg === "--agent" || arg === "-a") && rest[i + 1]) {
        const value = rest[++i] as AgentId;
        if (AGENTS.has(value)) {
          agent = value;
        }
      }
    }
    await runInit(agent, force);
    return;
  }

  if (command === "clear") {
    const path = resolve(rest[0] ?? process.cwd());
    await runClear(path);
    return;
  }

  const { content, rest: contentRest } = parseContentArgv(rest);
  const { topK, rest: sizedRest } = parseTopK(contentRest);

  if (command === "search") {
    const query = sizedRest[0];
    if (!query) {
      console.error("Usage: miru search <query> [path] [-k N] [--content ...]");
      process.exit(1);
    }
    const path = resolve(sizedRest[1] ?? process.cwd());
    await runSearch(path, query, topK, content);
    return;
  }

  if (command === "find-related") {
    const filePath = sizedRest[0];
    const lineRaw = sizedRest[1];
    if (!filePath || !lineRaw) {
      console.error("Usage: miru find-related <file_path> <line> [path] [-k N] [--content ...]");
      process.exit(1);
    }
    const line = Number(lineRaw);
    const path = resolve(sizedRest[2] ?? process.cwd());
    await runFindRelated(path, filePath, line, topK, content);
    return;
  }

  printHelp();
  process.exit(1);
}

async function runMcp(argv: string[]): Promise<void> {
  let path: string | null = null;
  let ref: string | null = null;
  const contentTokens: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref" && argv[i + 1]) {
      ref = argv[++i] ?? null;
      continue;
    }
    if (arg === "--content") {
      i++;
      while (i < argv.length) {
        const value = argv[i];
        if (value === undefined || value.startsWith("-")) {
          i--;
          break;
        }
        contentTokens.push(value);
        i++;
      }
      continue;
    }
    if (arg && !arg.startsWith("-") && path === null) {
      path = isGitUrl(arg) ? arg : resolve(arg);
    }
  }

  await serveMcp({
    path,
    ref,
    content: resolveContent(contentTokens.length > 0 ? contentTokens : ["code"]),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first && CLI_COMMANDS.has(first)) {
    await runCli(argv);
    return;
  }
  await runMcp(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
