#!/usr/bin/env bun
import { type AgentId, writeAgentFile } from "./agents.ts";
import { clearCache } from "./cache.ts";
import {
  fail,
  formatRelatedHeader,
  formatSearchErrorPretty,
  formatSearchResultsPretty,
  hint,
  prefersJsonOutput,
  success,
} from "./cli-ui.ts";
import { loadStoredCredentials } from "./credentials.ts";
import { loadEnvFiles } from "./env-files.ts";
import { normalizeTakaraApiKeyEnv } from "./env.ts";
import {
  AGENT_IDS,
  formatUnknownAgent,
  printCommandHelp,
  printFullHelp,
  printMainHelp,
} from "./help.ts";
import { runInstaller } from "./installer/installer.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import { ensureCredentials, runClearCredentials, runSetup } from "./setup.ts";
import { withSpinner } from "./spinner.ts";
import type { ContentType, SearchResult } from "./types.ts";
import { formatResults, resolveChunk, resolveContent, resolveSearchPath } from "./utils.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const CLI_COMMANDS = new Set([
  "search",
  "find-related",
  "init",
  "install",
  "uninstall",
  "setup",
  "clear",
  "help",
  "-h",
  "--help",
]);

const AGENTS = new Set<AgentId>(AGENT_IDS);

function parseFlagArgv(argv: string[], flag: string): { present: boolean; rest: string[] } {
  const rest: string[] = [];
  let present = false;
  for (const arg of argv) {
    if (arg === flag) {
      present = true;
      continue;
    }
    rest.push(arg);
  }
  return { present, rest };
}

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

function emitSearchOutput(
  query: string,
  results: SearchResult[],
  jsonFlag: boolean,
  emptyMessage = "No results found.",
): void {
  if (results.length === 0) {
    if (prefersJsonOutput(jsonFlag)) {
      console.log(JSON.stringify({ error: emptyMessage }));
      return;
    }
    process.stdout.write(formatSearchErrorPretty(emptyMessage));
    return;
  }

  if (prefersJsonOutput(jsonFlag)) {
    console.log(JSON.stringify(formatResults(query, results)));
    return;
  }

  process.stdout.write(formatSearchResultsPretty(query, results));
}

async function runSearch(
  path: string,
  query: string,
  topK: number,
  content: ContentType[],
  jsonFlag: boolean,
): Promise<void> {
  await ensureCredentials({ interactive: true });

  const index = await withSpinner("Indexing and searching", async () => {
    const built = await MiruIndex.fromSource(path, content);
    await built.saveToDefaultCache(path);
    const results = await built.search({ query, topK });
    return { index: built, results };
  });

  emitSearchOutput(query, index.results, jsonFlag);
}

async function runFindRelated(
  path: string,
  filePath: string,
  line: number,
  topK: number,
  content: ContentType[],
  jsonFlag: boolean,
): Promise<void> {
  await ensureCredentials({ interactive: true });

  const { results, label } = await withSpinner("Finding related chunks", async () => {
    const built = await MiruIndex.fromSource(path, content);
    const chunk = resolveChunk(built.chunks, filePath, line);
    if (!chunk) {
      throw new RelatedChunkNotFoundError(filePath, line);
    }
    const hits = await built.findRelated(chunk, topK);
    await built.saveToDefaultCache(path);
    return {
      results: hits,
      label: formatRelatedHeader(filePath, line),
    };
  });

  emitSearchOutput(label, results, jsonFlag, `No related chunks found for ${filePath}:${line}.`);
}

class RelatedChunkNotFoundError extends Error {
  constructor(filePath: string, line: number) {
    super(`No chunk found at ${filePath}:${line}.`);
    this.name = "RelatedChunkNotFoundError";
  }
}

async function runInit(agent: AgentId, force: boolean): Promise<void> {
  try {
    const dest = await writeAgentFile(agent, { force });
    success(`Wrote sub-agent: ${dest}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
    hint("Use --force to overwrite an existing file.");
    process.exit(1);
  }
}

async function runClear(path: string): Promise<void> {
  await clearCache(path);
  success(`Cleared cached index for ${path}`);
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

  if (command === "install" || command === "uninstall") {
    await runInstaller(command);
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
          fail("Missing value for --agent.");
          printCommandHelp("init");
          process.exit(1);
        }
        if (!AGENTS.has(value as AgentId)) {
          fail(formatUnknownAgent(value));
          process.exit(1);
        }
        agent = value as AgentId;
      }
    }
    if (!agent) {
      fail("miru init requires --agent.");
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
        fail("miru setup --clear cannot be combined with --key.");
        process.exit(1);
      }
      await runClearCredentials();
      return;
    }
    await runSetup({ apiKey, force });
    return;
  }

  if (command === "clear") {
    const path = resolveSearchPath(rest[0] ?? process.cwd());
    await runClear(path);
    return;
  }

  const { present: jsonFlag, rest: jsonRest } = parseFlagArgv(rest, "--json");
  const { content, rest: contentRest } = parseContentArgv(jsonRest);
  const { topK, rest: sizedRest } = parseTopK(contentRest);

  if (command === "search") {
    const query = sizedRest[0];
    if (!query) {
      printCommandHelp("search");
      process.exit(1);
    }
    const path = resolveSearchPath(sizedRest[1] ?? process.cwd());
    await runSearch(path, query, topK, content, jsonFlag);
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
    const path = resolveSearchPath(sizedRest[2] ?? process.cwd());
    try {
      await runFindRelated(path, filePath, line, topK, content, jsonFlag);
    } catch (err) {
      if (err instanceof RelatedChunkNotFoundError) {
        fail(err.message);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  fail(`Unknown command: ${command}`);
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
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
