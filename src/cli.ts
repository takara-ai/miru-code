#!/usr/bin/env bun
import { resolve } from "node:path";
import { type AgentId, writeAgentFile } from "./agents.ts";
import { clearCache } from "./cache.ts";
import { loadStoredCredentials } from "./credentials.ts";
import { loadEnvFiles } from "./env-files.ts";
import {
  AGENT_IDS,
  formatUnknownAgent,
  printCommandHelp,
  printFullHelp,
  printMainHelp,
} from "./help.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import { ensureCredentials, runClearCredentials, runSetup } from "./setup.ts";
import type { ContentType } from "./types.ts";
import { formatResults, resolveChunk, resolveContent } from "./utils.ts";

loadEnvFiles();
await loadStoredCredentials();

const CLI_COMMANDS = new Set([
  "search",
  "find-related",
  "init",
  "setup",
  "clear",
  "help",
  "-h",
  "--help",
]);

const AGENTS = new Set<AgentId>(AGENT_IDS);

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
  await ensureCredentials();
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
  await ensureCredentials();
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
  try {
    const dest = await writeAgentFile(agent, { force });
    process.stdout.write(`Wrote sub-agent: ${dest}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.stderr.write("Use --force to overwrite an existing file.\n");
    process.exit(1);
  }
}

async function runClear(path: string): Promise<void> {
  await clearCache(path);
  console.log(`Cleared cached index for: ${path}`);
}

async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    printMainHelp();
    return;
  }

  if (command === "-h" || command === "--help") {
    printFullHelp();
    return;
  }

  if (command === "help") {
    const topic = rest[0];
    if (!topic) {
      printMainHelp();
      return;
    }
    printCommandHelp(topic);
    return;
  }

  if (command === "init") {
    let agent: AgentId | undefined;
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--force") {
        force = true;
      } else if (arg === "--agent" || arg === "-a") {
        const value = rest[++i];
        if (!value) {
          process.stderr.write("Missing value for --agent.\n");
          printCommandHelp("init");
          process.exit(1);
        }
        if (!AGENTS.has(value as AgentId)) {
          process.stderr.write(`${formatUnknownAgent(value)}\n`);
          process.exit(1);
        }
        agent = value as AgentId;
      }
    }
    if (!agent) {
      process.stderr.write("miru init requires --agent.\n");
      printCommandHelp("init");
      process.exit(1);
    }
    await runInit(agent, force);
    return;
  }

  if (command === "setup") {
    let apiKey: string | undefined;
    let force = false;
    let clear = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--force") {
        force = true;
      } else if (arg === "--clear") {
        clear = true;
      } else if ((arg === "--key" || arg === "-k") && rest[i + 1]) {
        apiKey = rest[++i];
      }
    }
    if (clear) {
      if (apiKey) {
        console.error("Usage: miru setup --clear cannot be combined with --key.");
        process.exit(1);
      }
      await runClearCredentials();
      return;
    }
    await runSetup({ apiKey, force });
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
      printCommandHelp("search");
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
      printCommandHelp("find-related");
      process.exit(1);
    }
    const line = Number(lineRaw);
    const path = resolve(sizedRest[2] ?? process.cwd());
    await runFindRelated(path, filePath, line, topK, content);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printMainHelp();
  process.exit(1);
}

async function runMcp(argv: string[]): Promise<void> {
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
    }
  }

  await serveMcp({
    ref,
    content: resolveContent(contentTokens.length > 0 ? contentTokens : ["code"]),
  });
}

async function runMcpWithCredentials(argv: string[]): Promise<void> {
  await ensureCredentials({ interactive: false });
  await runMcp(argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first && CLI_COMMANDS.has(first)) {
    await runCli(argv);
    return;
  }
  await runMcpWithCredentials(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
