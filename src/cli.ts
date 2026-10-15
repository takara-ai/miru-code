#!/usr/bin/env bun
import { type AgentId, writeAgentFile } from "./agents.ts";
import { clearBenchmarkHistory, resolveBenchmarkHistoryPath } from "./benchmark/history.ts";
import { clearCache } from "./cache.ts";
import {
  parseContentArgv,
  parseExpandArgs,
  parseFlagArgv,
  parseInitArgs,
  parseLocateArgs,
  parseMcpArgs,
  UsageError,
} from "./cli-args.ts";
import { shouldRunMcp } from "./cli-mode.ts";
import {
  fail,
  formatRelatedHeader,
  formatSearchErrorPretty,
  formatSearchResultsPretty,
  hint,
  info,
  prefersJsonOutput,
  success,
  warn,
  writeStdout,
} from "./cli-ui.ts";
import { loadStoredCredentials } from "./credentials.ts";
import { normalizeTakaraApiKeyEnv } from "./env.ts";
import { loadEnvFiles } from "./env-files.ts";
import {
  AGENT_IDS,
  formatUnknownAgent,
  printCommandHelp,
  printEnvironmentHelp,
  printMainHelp,
  printSageMakerHelp,
} from "./help.ts";
import { getBenchmarkModeStatus, setBenchmarkMode } from "./installer/benchmark-mode.ts";
import { runInstaller } from "./installer/installer.ts";
import { promptConfirm } from "./installer/prompt.ts";
import { DEFAULT_LITERAL_MODE, formatLiteralLocate, type LiteralLocateOptions } from "./literal.ts";
import { serveMcp } from "./mcp/serve.ts";
import { MiruIndex } from "./miru-index.ts";
import {
  canPromptForCredentials,
  ensureCredentials,
  parseSetupCliArgs,
  runClearCredentials,
  runSetup,
  type SetupCliArgError,
} from "./setup.ts";
import { withSpinner } from "./spinner.ts";
import type { ContentType, SearchResult } from "./types.ts";
import {
  expandChunksAtLine,
  formatExpandResults,
  formatResults,
  localRepoRoot,
  resolveChunk,
  resolveSearchPath,
  SEARCH_RESULT_COUNT,
} from "./utils.ts";
import { maybeNotifyUpdate, miruVersion } from "./version.ts";

process.title = "miru";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
// Soft-fail: expired/revoked device refresh must not brick `miru -v`, `setup --clear`, etc.
// Command paths call ensureCredentials() which recovers interactively when allowed.
try {
  await loadStoredCredentials();
} catch {
  // Leave recovery to ensureCredentials / setup.
}

const AGENTS = new Set<AgentId>(AGENT_IDS);

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
  content: ContentType[],
  jsonFlag: boolean,
): Promise<void> {
  await ensureCredentials({ interactive: true });

  const index = await withSpinner("Indexing and searching", async () => {
    const built = await MiruIndex.fromSource(path, content);
    await built.saveToCache(path);
    const results = await built.search({ query, topK: SEARCH_RESULT_COUNT });
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
    const hits = await built.findRelated(chunk, SEARCH_RESULT_COUNT);
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

  throw new UsageError(
    `Unknown benchmark action "${action}". Use on, off, status, or clear.`,
    "benchmark",
  );
}

interface QueryContext {
  content: ContentType[];
  json: boolean;
}

type Handler = (rest: string[]) => Promise<void>;

/** Wrap a search-style command: strips `--json` / `--content` and hands over the remaining positionals. */
function queryCommand(run: (args: string[], ctx: QueryContext) => Promise<void>): Handler {
  return async (rest) => {
    const { present: json, rest: withoutJson } = parseFlagArgv(rest, "--json");
    const { content, rest: args } = parseContentArgv(withoutJson);
    await run(args, { content, json });
  };
}

function rejectTopK(args: string[]): void {
  if (args.some((arg) => arg === "-k" || arg === "--top-k")) {
    throw new UsageError(
      "The -k/--top-k option has been removed; Miru returns a fixed number of results.",
    );
  }
}

/** Positional `FILE LINE [PATH]` shared by `expand` and `find-related`. */
function parseFileLine(topic: string, args: string[]) {
  const [filePath, lineRaw, pathArg] = args;
  if (!filePath || !lineRaw) throw new UsageError("", topic);
  return { filePath, line: Number(lineRaw), path: resolveSearchPath(pathArg ?? process.cwd()) };
}

const SETUP_CONFLICTS: Record<SetupCliArgError, string> = {
  clear_with_key: "miru setup --clear cannot be combined with --key, --device, or --sagemaker.",
  sagemaker_with_key: "miru setup --sagemaker cannot be combined with --key.",
  device_with_key: "miru setup accepts either --device or --key TOKEN, not both.",
  device_with_sagemaker: "miru setup --device cannot be combined with --sagemaker.",
};

async function runSetupCommand(rest: string[]): Promise<void> {
  const { args, error } = parseSetupCliArgs(rest);
  if (error) throw new UsageError(SETUP_CONFLICTS[error]);

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
  if (!newlySaved) return;

  const offerInstall = canPromptForCredentials() && !args.apiKey && !args.device && !args.force;
  if (offerInstall && (await promptConfirm("Configure Miru in your coding agent now?"))) {
    await runInstaller("install");
    return;
  }
  hint("To add Miru to your IDE, run `miru install`.");
}

async function runInitCommand(rest: string[]): Promise<void> {
  const { agent, force } = parseInitArgs(rest);
  if (!agent) throw new UsageError("miru init requires --agent.", "init");
  if (!AGENTS.has(agent as AgentId)) throw new UsageError(formatUnknownAgent(agent));
  await runInit(agent as AgentId, force);
}

const COMMANDS: Record<string, Handler> = {
  install: () => runInstaller("install"),
  uninstall: () => runInstaller("uninstall"),
  benchmark: runBenchmarkCommand,
  init: runInitCommand,
  setup: runSetupCommand,
  clear: ([path]) => runClear(resolveSearchPath(path ?? process.cwd())),

  search: queryCommand(async (args, { content, json }) => {
    rejectTopK(args);
    const [query, pathArg] = args;
    if (!query) throw new UsageError("", "search");
    await runSearch(resolveSearchPath(pathArg ?? process.cwd()), query, content, json);
  }),

  locate: queryCommand(async ([literal, ...flags], { content, json }) => {
    if (!literal) throw new UsageError("", "locate");
    const { options, pathArg } = parseLocateArgs(flags);
    await runLocate(resolveSearchPath(pathArg ?? process.cwd()), literal, content, json, options);
  }),

  expand: queryCommand(async (args, { content, json }) => {
    const { filePath, line, path } = parseFileLine("expand", args);
    const { before, after } = parseExpandArgs(args.slice(3));
    await runExpand(path, filePath, line, before, after, content, json);
  }),

  "find-related": queryCommand(async (args, { content, json }) => {
    rejectTopK(args);
    const { filePath, line, path } = parseFileLine("find-related", args);
    await runFindRelated(path, filePath, line, content, json);
  }),
};

const isHelpFlag = (arg: string | undefined) => arg === "-h" || arg === "--help";

async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === undefined || isHelpFlag(command)) return printMainHelp();

  if (command === "help") {
    const topic = rest[0];
    return !topic || isHelpFlag(topic) ? printMainHelp() : printCommandHelp(topic);
  }

  if (command === "env" || command === "environment") return printEnvironmentHelp();

  if (command === "setup" && rest.some(isHelpFlag) && rest.includes("--sagemaker")) {
    return printSageMakerHelp();
  }
  if (isHelpFlag(rest[0]) || (command === "setup" && rest.some(isHelpFlag))) {
    return printCommandHelp(command);
  }

  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) {
    fail(`Unknown command: ${command}`);
    printMainHelp();
    process.exit(1);
  }
  await handler(rest);
}

async function runMcp(argv: string[]): Promise<void> {
  await serveMcp(parseMcpArgs(argv));
}

async function runMcpWithCredentials(argv: string[]): Promise<void> {
  // The MCP server is spawned as a headless stdio subprocess, never a real
  // login terminal, so it must never crash the whole process over missing
  // credentials — that would kill every tool, not just the ones needing
  // embeddings. Best-effort load/refresh whatever's already stored; leave it
  // to individual tool calls to report a missing-credentials error, and to
  // the `auth` tool (src/mcp/auth-tool.ts) to complete device-code login
  // in-band without a terminal.
  await loadStoredCredentials().catch((err: unknown) => {
    // Swallow so a stale/revoked refresh token etc. can't crash the server — but
    // don't swallow silently, or the only symptom is a later "credentials
    // required" tool error with no clue why stored credentials didn't work.
    warn(`Could not load stored credentials: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  });
  await runMcp(argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  // Old hook configs may survive until the next install/uninstall; let their
  // search commands proceed normally while the installer removes the hooks.
  if (first === "hook-guard") return;

  if (first === "-v" || first === "--version") {
    console.log(miruVersion());
    return;
  }

  const updateNotice = maybeNotifyUpdate();

  if (shouldRunMcp(argv, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))) {
    await updateNotice;
    await runMcpWithCredentials(first === "mcp" ? argv.slice(1) : argv);
    return;
  }

  await Promise.all([runCli(argv), updateNotice]);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    if (err.message) fail(err.message);
    if (err.helpTopic) printCommandHelp(err.helpTopic);
  } else {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
