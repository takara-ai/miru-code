#!/usr/bin/env bun
import { type AgentId, writeAgentFile } from "./agents.ts";
import { clearBenchmarkHistory, resolveBenchmarkHistoryPath } from "./benchmark/history.ts";
import { clearCache } from "./cache.ts";
import {
  fail,
  formatRelatedHeader,
  formatSearchErrorPretty,
  formatSearchResultsPretty,
  hint,
  info,
  prefersJsonOutput,
  success,
  writeStdout,
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
import { getBenchmarkModeStatus, setBenchmarkMode } from "./installer/benchmark-mode.ts";
import { runSearchGuardFromStdin } from "./installer/hooks/search-guard.ts";
import { runInstaller } from "./installer/installer.ts";
import { promptConfirm } from "./installer/prompt.ts";
import {
  DEFAULT_LITERAL_MODE,
  formatLiteralLocate,
  type LiteralLocateOptions,
  type LiteralMode,
} from "./literal.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import {
  canPromptForCredentials,
  ensureCredentials,
  parseSetupCliArgs,
  runClearCredentials,
  runSetup,
} from "./setup.ts";
import { withSpinner } from "./spinner.ts";
import type { ContentType, SearchResult } from "./types.ts";
import {
  DEFAULT_EXPAND_AFTER,
  DEFAULT_EXPAND_BEFORE,
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  resolveChunk,
  resolveContent,
  resolveSearchPath,
} from "./utils.ts";
import { maybeNotifyUpdate, miruVersion } from "./version.ts";

process.title = "miru";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const CLI_COMMANDS = new Set([
  "search",
  "locate",
  "expand",
  "find-related",
  "init",
  "install",
  "uninstall",
  "setup",
  "clear",
  "benchmark",
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
  return { content: resolveContent(content), rest };
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
    await built.saveToCache(path);
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
    await built.saveToCache(path);
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
    await built.saveToCache(path);
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

async function runLocate(
  path: string,
  literal: string,
  content: ContentType[],
  jsonFlag: boolean,
  options: LiteralLocateOptions,
): Promise<void> {
  await ensureCredentials({ interactive: true });
  const mode = options.mode ?? DEFAULT_LITERAL_MODE;

  const payload = await withSpinner("Locating literal", async () => {
    const built = await MiruIndex.fromSource(path, content);
    await built.saveToCache(path);
    return formatLiteralLocate(built.locateLiteral(literal, options));
  });

  if (prefersJsonOutput(jsonFlag)) {
    console.log(JSON.stringify(payload));
    return;
  }

  const n = Number(payload.n ?? 0);
  const files = Number(payload.files ?? 0);
  writeStdout(`literal=${literal}  n=${n}  files=${files}  mode=${mode}`);
  const hits = payload.hits as
    | Array<{ f: string; l: number; t?: string; ctx?: string[]; ctx_l?: number }>
    | undefined;
  if (hits) {
    for (const hit of hits) {
      if (hit.ctx !== undefined) {
        writeStdout(`  ${hit.f}:${hit.l}:`);
        const startLine = hit.ctx_l ?? hit.l;
        hit.ctx.forEach((line, i) => {
          writeStdout(`    ${startLine + i}: ${line}`);
        });
      } else if (hit.t !== undefined) {
        writeStdout(`  ${hit.f}:${hit.l}: ${hit.t}`);
      } else {
        writeStdout(`  ${hit.f}:${hit.l}`);
      }
    }
    if (payload.truncated) {
      writeStdout(`  … truncated (showing ${hits.length} of ${n})`);
    }
  }
  writeStdout("");
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

async function runBenchmarkCommand(rest: string[]): Promise<void> {
  const action = rest[0];
  if (!action || action === "-h" || action === "--help") {
    printCommandHelp("benchmark");
    return;
  }

  if (action === "status") {
    const rows = await getBenchmarkModeStatus();
    const installed = rows.filter((row) => row.action !== "missing");
    if (installed.length === 0) {
      info("No Miru MCP installs found. Run `miru install` first.");
      return;
    }
    for (const row of installed) {
      writeStdout(`  ${row.enabled ? "on " : "off"}  ${row.agent.padEnd(16)} ${row.path}`);
    }
    const onCount = installed.filter((row) => row.enabled).length;
    writeStdout("");
    if (onCount > 0) {
      hint(
        `Benchmark mode on for ${onCount}/${installed.length}. Run \`miru benchmark off\` to leave.`,
      );
    } else {
      hint("Benchmark mode is off for all installed agents.");
    }
    return;
  }

  if (action === "on" || action === "off") {
    const enabled = action === "on";
    const rows = await setBenchmarkMode(enabled);
    const touched = rows.filter((row) => row.action === "updated" || row.action === "unchanged");
    if (touched.length === 0) {
      info("No Miru MCP installs found. Run `miru install` first.");
      return;
    }
    for (const row of touched) {
      const label = row.action === "updated" ? (enabled ? "enabled" : "disabled") : "unchanged";
      writeStdout(`  ${label.padEnd(9)} ${row.agent.padEnd(16)} ${row.path}`);
    }
    writeStdout("");
    success(
      enabled
        ? "Benchmark mode on. Restart agents to apply."
        : "Benchmark mode off. Restart agents to apply.",
    );
    if (enabled) {
      hint("Leave anytime with `miru benchmark off`.");
    }
    return;
  }

  if (action === "clear") {
    const path = resolveBenchmarkHistoryPath();
    const result = await clearBenchmarkHistory(path);
    if (result.cleared) {
      success(`Cleared benchmark report ${result.path}`);
    } else {
      info(`No benchmark report at ${result.path}`);
    }
    return;
  }

  fail(`Unknown benchmark action "${action}". Use on, off, status, or clear.`);
  printCommandHelp("benchmark");
  process.exit(1);
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

  if (command === "benchmark") {
    await runBenchmarkCommand(rest);
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
    const { args, error } = parseSetupCliArgs(rest);
    if (error === "clear_with_key") {
      fail("miru setup --clear cannot be combined with --key, --device, or --sagemaker.");
      process.exit(1);
    }
    if (error === "sagemaker_with_key") {
      fail("miru setup --sagemaker cannot be combined with --key.");
      process.exit(1);
    }
    if (error === "device_with_key") {
      fail("miru setup accepts either --device or --key TOKEN, not both.");
      process.exit(1);
    }
    if (error === "device_with_sagemaker") {
      fail("miru setup --device cannot be combined with --sagemaker.");
      process.exit(1);
    }
    if (args.clear) {
      await runClearCredentials();
      return;
    }
    const { newlySaved } = await runSetup({
      apiKey: args.apiKey,
      device: args.device,
      force: args.force,
      sagemaker: args.sagemaker,
      sagemakerArn: args.sagemakerArn,
      profile: args.profile,
    });
    if (newlySaved) {
      const offerInstall =
        canPromptForCredentials() && !args.apiKey && !args.device && !args.force;
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

  if (command === "locate") {
    const literal = sizedRest[0];
    if (!literal) {
      printCommandHelp("locate");
      process.exit(1);
    }
    const options: LiteralLocateOptions = {};
    const include: string[] = [];
    const exclude: string[] = [];
    const pathArgs: string[] = [];
    const positiveInt = (flag: string, raw: string | undefined, min: number): number => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min) {
        fail(
          `locate ${flag} must be a${min === 0 ? " non-negative" : ""} integer${min > 0 ? ` ≥ ${min}` : ""}.`,
        );
        process.exit(1);
      }
      return Math.floor(n);
    };
    for (let i = 1; i < sizedRest.length; i++) {
      const arg = sizedRest[i];
      if (arg === "--mode" && sizedRest[i + 1]) {
        const value = sizedRest[++i];
        if (value !== "count" && value !== "locations" && value !== "lines") {
          fail(`Unknown locate mode "${value}". Use count, locations, or lines.`);
          process.exit(1);
        }
        options.mode = value as LiteralMode;
        continue;
      }
      if (arg === "--limit" && sizedRest[i + 1]) {
        options.limit = positiveInt("--limit", sizedRest[++i], 1);
        continue;
      }
      if (arg === "--ignore-case") {
        options.ignore_case = true;
        continue;
      }
      if (arg === "--match-variants") {
        options.match_variants = true;
        continue;
      }
      if (arg === "--include" && sizedRest[i + 1]) {
        include.push(sizedRest[++i] as string);
        continue;
      }
      if (arg === "--exclude" && sizedRest[i + 1]) {
        exclude.push(sizedRest[++i] as string);
        continue;
      }
      if (arg === "--context" && sizedRest[i + 1]) {
        options.context_lines = positiveInt("--context", sizedRest[++i], 0);
        continue;
      }
      if (arg !== undefined) {
        pathArgs.push(arg);
      }
    }
    if (include.length > 0) {
      options.include = include;
    }
    if (exclude.length > 0) {
      options.exclude = exclude;
    }
    const path = resolveSearchPath(pathArgs[0] ?? process.cwd());
    await runLocate(path, literal, content, jsonFlag, options);
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
    let before = DEFAULT_EXPAND_BEFORE;
    let after = DEFAULT_EXPAND_AFTER;
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
  let benchmark = false;
  const contentTokens: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--benchmark") {
      benchmark = true;
      continue;
    }
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
    content: resolveContent(contentTokens),
    benchmark,
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
