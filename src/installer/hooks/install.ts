import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HooksFormat, InstallAction } from "../agents.ts";
import { stripJsonComments } from "../config.ts";

const HOOK_GUARD_MARKER = "hook-guard";
const MIRU_HOOK_MARKER = "miru-search";

const MATCHERS = {
  cursor: "Grep|Glob|Shell|SemanticSearch",
  claude: "Grep|Glob|Bash|grep|read_file",
  gemini: "grep_search|glob_file_search|codebase_search",
  kiroGrep: "grep",
  kiroGlob: "glob",
  kiroShell: "shell",
} as const;

function parseJsonObject(text: string): Record<string, unknown> | "error" {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(trimmed));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "error";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "error";
  }
}

function shellQuote(path: string): string {
  if (/^[a-zA-Z0-9_./:@%-]+$/.test(path)) {
    return path;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Resolve the shell command miru install writes into hook configs. */
export function resolveHookCommand(): string {
  const entry = process.argv[1];
  if (entry) {
    const resolved = resolve(entry);
    if (resolved.endsWith(".ts")) {
      return `bun run ${shellQuote(resolved)} hook-guard`;
    }
    return `${shellQuote(resolved)} hook-guard`;
  }
  return "miru hook-guard";
}

function hookCommandMatches(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_GUARD_MARKER);
}

function isEmptyHookConfig(parsed: Record<string, unknown>): boolean {
  if (Object.keys(parsed).length === 0) {
    return true;
  }
  const hooks = parsed.hooks;
  if (hooks === undefined) {
    return Object.keys(parsed).every((key) => key === "version");
  }
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return false;
  }
  return Object.keys(hooks as Record<string, unknown>).length === 0;
}

function removeMiruHookEntries<T extends Record<string, unknown>>(
  entries: T[],
  isMiru: (entry: T) => boolean,
): T[] {
  return entries.filter((entry) => !isMiru(entry));
}

function pascalPreToolUseEntry(command: string, matcher: string): Record<string, unknown> {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command,
        statusMessage: "Miru search policy",
      },
    ],
  };
}

function cursorHookEntry(command: string): Record<string, unknown> {
  return {
    command,
    matcher: MATCHERS.cursor,
  };
}

function geminiBeforeToolEntry(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    matcher: MATCHERS.gemini,
    timeout: 15_000,
  };
}

function kiroPreToolUseEntry(command: string, matcher: string): Record<string, unknown> {
  return {
    matcher,
    command,
  };
}

function windsurfPreRunEntry(command: string): Record<string, unknown> {
  return { command };
}

async function writeJson(
  path: string,
  data: Record<string, unknown>,
  existed: boolean,
): Promise<InstallAction> {
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  return existed ? "updated" : "created";
}

async function mergeHooksSection(
  path: string,
  eventKey: string,
  nextEntries: Record<string, unknown>[],
  isMiruEntry: (entry: Record<string, unknown>) => boolean,
  buildEntry: (command: string) => Record<string, unknown>,
): Promise<InstallAction> {
  const command = resolveHookCommand();
  const existed = await Bun.file(path).exists();
  const text = existed ? await Bun.file(path).text() : "";
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const hooksRoot =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...(parsed.hooks as Record<string, unknown>) }
      : {};

  const existing = Array.isArray(hooksRoot[eventKey])
    ? [...(hooksRoot[eventKey] as Record<string, unknown>[])]
    : [];

  const filtered = removeMiruHookEntries(existing, isMiruEntry);
  const rebuilt = nextEntries.length > 0 ? nextEntries : [buildEntry(command)];
  const nextSection = [...filtered, ...rebuilt];

  if (JSON.stringify(existing) === JSON.stringify(nextSection)) {
    return "unchanged";
  }

  hooksRoot[eventKey] = nextSection;
  parsed.hooks = hooksRoot;
  return writeJson(path, parsed, existed);
}

async function removeHooksSection(
  path: string,
  eventKeys: string[],
  isMiruEntry: (entry: Record<string, unknown>) => boolean,
): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) {
    return "not-found";
  }

  const text = await Bun.file(path).text();
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const hooksRoot =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? (parsed.hooks as Record<string, unknown>)
      : null;
  if (!hooksRoot) {
    return "not-found";
  }

  let changed = false;
  for (const eventKey of eventKeys) {
    if (!Array.isArray(hooksRoot[eventKey])) {
      continue;
    }
    const filtered = removeMiruHookEntries(
      hooksRoot[eventKey] as Record<string, unknown>[],
      isMiruEntry,
    );
    if (filtered.length !== (hooksRoot[eventKey] as unknown[]).length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooksRoot[eventKey];
      } else {
        hooksRoot[eventKey] = filtered;
      }
    }
  }

  if (!changed) {
    return "not-found";
  }

  if (Object.keys(hooksRoot).length === 0) {
    delete parsed.hooks;
  } else {
    parsed.hooks = hooksRoot;
  }

  if (isEmptyHookConfig(parsed)) {
    await unlink(path);
    return "removed";
  }

  await Bun.write(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return "removed";
}

export async function mergeCursorHooks(path: string): Promise<InstallAction> {
  const command = resolveHookCommand();
  const existed = await Bun.file(path).exists();
  const text = existed ? await Bun.file(path).text() : "";
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const hooksRoot =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? (parsed.hooks as Record<string, unknown>)
      : {};

  const preToolUse = Array.isArray(hooksRoot.preToolUse)
    ? [...(hooksRoot.preToolUse as Record<string, unknown>[])]
    : [];

  const nextEntry = cursorHookEntry(command);
  const existingIdx = preToolUse.findIndex((entry) => hookCommandMatches(entry.command));
  if (existingIdx >= 0) {
    if (JSON.stringify(preToolUse[existingIdx]) === JSON.stringify(nextEntry)) {
      return "unchanged";
    }
    preToolUse[existingIdx] = nextEntry;
  } else {
    preToolUse.push(nextEntry);
  }

  const next = {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    hooks: { ...hooksRoot, preToolUse },
  };

  return writeJson(path, next, existed);
}

export async function removeCursorHooks(path: string): Promise<InstallAction> {
  return removeHooksSection(path, ["preToolUse"], (entry) => hookCommandMatches(entry.command));
}

export async function mergeClaudeHooks(path: string): Promise<InstallAction> {
  return mergeHooksSection(
    path,
    "PreToolUse",
    [],
    (entry) => {
      const nested = entry.hooks;
      if (!Array.isArray(nested)) {
        return false;
      }
      return nested.some((hook) => hookCommandMatches((hook as Record<string, unknown>).command));
    },
    (command) => pascalPreToolUseEntry(command, MATCHERS.claude),
  );
}

export async function removeClaudeHooks(path: string): Promise<InstallAction> {
  return removeHooksSection(path, ["PreToolUse"], (entry) => {
    const nested = entry.hooks;
    if (!Array.isArray(nested)) {
      return false;
    }
    return nested.some((hook) => hookCommandMatches((hook as Record<string, unknown>).command));
  });
}

export async function mergeGeminiHooks(path: string): Promise<InstallAction> {
  return mergeHooksSection(
    path,
    "BeforeTool",
    [],
    (entry) => hookCommandMatches(entry.command),
    (command) => geminiBeforeToolEntry(command),
  );
}

export async function removeGeminiHooks(path: string): Promise<InstallAction> {
  return removeHooksSection(path, ["BeforeTool"], (entry) => hookCommandMatches(entry.command));
}

export async function mergeVscodeHooks(path: string): Promise<InstallAction> {
  const command = resolveHookCommand();
  const content = {
    hooks: {
      PreToolUse: [
        {
          type: "command",
          command,
          matcher: MATCHERS.claude,
          statusMessage: "Miru search policy",
        },
      ],
    },
  };
  const existed = await Bun.file(path).exists();
  if (existed) {
    const current = await Bun.file(path).text();
    const next = `${JSON.stringify(content, null, 2)}\n`;
    if (current === next) {
      return "unchanged";
    }
  }
  await Bun.write(path, `${JSON.stringify(content, null, 2)}\n`);
  return existed ? "updated" : "created";
}

export async function removeVscodeHooks(path: string): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) {
    return "not-found";
  }
  const text = await Bun.file(path).text();
  if (!text.includes(HOOK_GUARD_MARKER) && !text.includes(MIRU_HOOK_MARKER)) {
    return "not-found";
  }
  await unlink(path);
  return "removed";
}

export async function mergeKiroHooks(path: string): Promise<InstallAction> {
  const command = resolveHookCommand();
  const existed = await Bun.file(path).exists();
  const text = existed ? await Bun.file(path).text() : "";
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const hooksRoot =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...(parsed.hooks as Record<string, unknown>) }
      : {};

  const matchers = [MATCHERS.kiroGrep, MATCHERS.kiroGlob, MATCHERS.kiroShell] as const;
  const existing = Array.isArray(hooksRoot.preToolUse)
    ? [...(hooksRoot.preToolUse as Record<string, unknown>[])]
    : [];

  const filtered = removeMiruHookEntries(existing, (entry) => hookCommandMatches(entry.command));
  const miruEntries = matchers.map((matcher) => kiroPreToolUseEntry(command, matcher));
  const nextSection = [...filtered, ...miruEntries];

  if (JSON.stringify(existing) === JSON.stringify(nextSection)) {
    return "unchanged";
  }

  hooksRoot.preToolUse = nextSection;
  parsed.hooks = hooksRoot;
  return writeJson(path, parsed, existed);
}

export async function removeKiroHooks(path: string): Promise<InstallAction> {
  return removeHooksSection(path, ["preToolUse"], (entry) => hookCommandMatches(entry.command));
}

export async function mergeWindsurfHooks(path: string): Promise<InstallAction> {
  return mergeHooksSection(
    path,
    "pre_run_command",
    [],
    (entry) => hookCommandMatches(entry.command),
    (command) => windsurfPreRunEntry(command),
  );
}

export async function removeWindsurfHooks(path: string): Promise<InstallAction> {
  return removeHooksSection(path, ["pre_run_command"], (entry) =>
    hookCommandMatches(entry.command),
  );
}

export async function mergeOpenCodePlugin(pluginPath: string): Promise<InstallAction> {
  const source = join(import.meta.dir, "opencode-plugin.ts");
  const content = await Bun.file(source).text();
  const existed = await Bun.file(pluginPath).exists();
  if (existed && (await Bun.file(pluginPath).text()) === content) {
    return "unchanged";
  }
  await Bun.write(pluginPath, content);
  return existed ? "updated" : "created";
}

export async function removeOpenCodePlugin(pluginPath: string): Promise<InstallAction> {
  if (!(await Bun.file(pluginPath).exists())) {
    return "not-found";
  }
  await unlink(pluginPath);
  return "removed";
}

export async function mergeHooks(format: HooksFormat, path: string): Promise<InstallAction> {
  switch (format) {
    case "cursor":
      return mergeCursorHooks(path);
    case "claude":
      return mergeClaudeHooks(path);
    case "gemini":
      return mergeGeminiHooks(path);
    case "vscode":
      return mergeVscodeHooks(path);
    case "kiro":
      return mergeKiroHooks(path);
    case "windsurf":
      return mergeWindsurfHooks(path);
    case "opencode":
      return mergeOpenCodePlugin(path);
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

export async function removeHooks(format: HooksFormat, path: string): Promise<InstallAction> {
  switch (format) {
    case "cursor":
      return removeCursorHooks(path);
    case "claude":
      return removeClaudeHooks(path);
    case "gemini":
      return removeGeminiHooks(path);
    case "vscode":
      return removeVscodeHooks(path);
    case "kiro":
      return removeKiroHooks(path);
    case "windsurf":
      return removeWindsurfHooks(path);
    case "opencode":
      return removeOpenCodePlugin(path);
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}
