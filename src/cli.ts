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
import { normalizeTakaraApiKeyEnv } from "./env.ts";
import { loadEnvFiles } from "./env-files.ts";
import {
  AGENT_IDS,
  formatUnknownAgent,
  printCommandHelp,
  printFullHelp,
  printMainHelp,
} from "./help.ts";
import { runSearchGuardFromStdin } from "./installer/hooks/search-guard.ts";
import { runInstaller } from "./installer/installer.ts";
import { promptConfirm } from "./installer/prompt.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import {
  canPromptForCredentials,
  ensureCredentials,
  runClearCredentials,
  runSetup,
} from "./setup.ts";
import { withSpinner } from "./spinner.ts";
import type { ContentType, SearchResult } from "./types.ts";
import {
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  resolveChunk,
  resolveContent,
  resolveSearchPath,
} from "./utils.ts";
import { maybeNotifyUpdate, miruVersion } from "./version.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const CLI_COMMANDS = new Set([
  "search",
  "expand",
  "find-related",
  "init",
  "install",
  "uninstall",
  "setup",
  "clear",
  "hook-guard",
  "help",
  "-h",
  "--help",
  "-v",
  "--version",
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

async function runExpand(
  path: string,
  filePath: string,
  line: number,
  before: number,
  after: number,
  content: ContentType[],
  jsonFlag: boolean,
): Promise<void> {
  await ensureCredentials({ interactive: true });

  const payload = await withSpinner("Expanding chunks", async () => {
    const built = await MiruIndex.fromSource(path, content);
    const repoRoot = localRepoRoot(path);
    const { anchor, chunks: expanded } = expandChunksAtLine(
      built.chunks,
      filePath,
      line,
      repoRoot,
      before,
      after,
    );
    await built.saveToDefaultCache(path);
    return formatExpandResults(filePath, line, anchor, expanded, {
      repoRoot,
      before,
      after,
    });
  });

  if (!payload.anchor) {
    fail(`No chunk found at ${filePath}:${line}.`);
    process.exit(1);
  }

  if (prefersJsonOutput(jsonFlag)) {
    console.log(JSON.stringify(payload));
    return;
  }

  const chunks = payload.chunks as Array<{ location?: string; content?: string }>;
  for (const chunk of chunks) {
    process.stdout.write(`\n${chunk.location ?? ""}\n`);
    process.stdout.write(`${chunk.content ?? ""}\n`);
  }
  process.stdout.write("\n");
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

  if (command === "-v" || command === "--version") {
    console.log(miruVersion());
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

  if (command === "hook-guard") {
    process.exit(await runSearchGuardFromStdin());
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
    let device = false;
    let force = false;
    let clear = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--force") {
        force = true;
      } else if (arg === "--device") {
        device = true;
      } else if (arg === "--clear") {
        clear = true;
      } else if ((arg === "--key" || arg === "-k") && rest[i + 1]) {
        apiKey = rest[++i];
      }
    }
    if (clear) {
      if (apiKey || device) {
        fail("miru setup --clear cannot be combined with --key or --device.");
        process.exit(1);
      }
      await runClearCredentials();
      return;
    }
    if (apiKey && device) {
      fail("miru setup accepts either --device or --key TOKEN, not both.");
      process.exit(1);
    }
    const { newlySaved } = await runSetup({ apiKey, device, force });
    if (newlySaved) {
      const offerInstall = canPromptForCredentials() && !apiKey && !device && !force;
      if (offerInstall) {
        const install = await promptConfirm("Configure Miru in your coding agent now?");
        if (install) {
          await runInstaller("install");
          return;
        }
      }
      hint("Run `miru install` to add Miru to your IDE.");
    }
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

  if (command === "expand") {
    const filePath = sizedRest[0];
    const lineRaw = sizedRest[1];
    if (!filePath || !lineRaw) {
      printCommandHelp("expand");
      process.exit(1);
    }
    const line = Number(lineRaw);
    const path = resolveSearchPath(sizedRest[2] ?? process.cwd());
    let before = 1;
    let after = 1;
    for (let i = 3; i < sizedRest.length; i++) {
      const arg = sizedRest[i];
      if (arg === "--before" && sizedRest[i + 1]) {
        before = Number(sizedRest[++i]);
      } else if (arg === "--after" && sizedRest[i + 1]) {
        after = Number(sizedRest[++i]);
      }
    }
    await runExpand(path, filePath, line, before, after, content, jsonFlag);
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
    await runFindRelated(path, filePath, line, topK, content, jsonFlag);
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
  await ensureCredentials({ interactive: true });
  await runMcp(argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === "-v" || first === "--version") {
    console.log(miruVersion());
    return;
  }

  if (first === "hook-guard") {
    process.exit(await runSearchGuardFromStdin());
  }

  const updateNotice = maybeNotifyUpdate();

  if (first && CLI_COMMANDS.has(first)) {
    await Promise.all([runCli(argv), updateNotice]);
    return;
  }

  await updateNotice;
  await runMcpWithCredentials(argv);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
