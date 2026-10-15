import type { LiteralLocateOptions, LiteralMode } from "./literal.ts";
import type { ContentType } from "./types.ts";
import { DEFAULT_EXPAND_AFTER, DEFAULT_EXPAND_BEFORE, resolveContent } from "./utils.ts";

/** A user-facing argv mistake. `helpTopic` names the command whose help to print after the message. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly helpTopic?: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

const LOCATE_MODES: readonly LiteralMode[] = ["count", "files", "locations", "lines"];

/** Remove every occurrence of a boolean flag, reporting whether it was present. */
export function parseFlagArgv(argv: string[], flag: string): { present: boolean; rest: string[] } {
  const rest = argv.filter((arg) => arg !== flag);
  return { present: rest.length !== argv.length, rest };
}

/** Pull `--content a b c` (values run until the next dash-prefixed token) out of argv. */
export function parseContentArgv(argv: string[]): { content: ContentType[]; rest: string[] } {
  const rest: string[] = [];
  const tokens: string[] = [];
  let collecting = false;
  for (const arg of argv) {
    if (arg === "--content") {
      collecting = true;
    } else if (collecting && !arg.startsWith("-")) {
      tokens.push(arg);
    } else {
      collecting = false;
      rest.push(arg);
    }
  }
  return { content: resolveContent(tokens), rest };
}

/** Walks argv left to right, letting flags consume their value with a uniform "missing value" error. */
class ArgCursor {
  private i = 0;

  constructor(
    private readonly args: readonly string[],
    private readonly helpTopic: string,
  ) {}

  next(): string | undefined {
    return this.args[this.i++];
  }

  value(flag: string): string {
    const value = this.args[this.i++];
    if (value === undefined) {
      throw new UsageError(`Missing value for ${flag}.`, this.helpTopic);
    }
    return value;
  }

  integer(flag: string, min: number): number {
    const n = Number(this.value(flag));
    if (!Number.isInteger(n) || n < min) {
      const kind = min === 0 ? "a non-negative integer" : `an integer ≥ ${min}`;
      throw new UsageError(`${this.helpTopic} ${flag} must be ${kind}.`);
    }
    return n;
  }
}

export interface LocateArgs {
  options: LiteralLocateOptions;
  pathArg?: string;
}

/** Parse the flags and optional path that follow the literal in `miru locate`. */
export function parseLocateArgs(args: readonly string[]): LocateArgs {
  const options: LiteralLocateOptions = {};
  const include: string[] = [];
  const exclude: string[] = [];
  let pathArg: string | undefined;

  const cursor = new ArgCursor(args, "locate");
  for (let arg = cursor.next(); arg !== undefined; arg = cursor.next()) {
    switch (arg) {
      case "--mode": {
        const mode = cursor.value(arg);
        if (!LOCATE_MODES.includes(mode as LiteralMode)) {
          throw new UsageError(
            `Unknown locate mode "${mode}". Use ${LOCATE_MODES.slice(0, -1).join(", ")}, or ${LOCATE_MODES.at(-1)}.`,
          );
        }
        options.mode = mode as LiteralMode;
        break;
      }
      case "--limit":
        options.limit = cursor.integer(arg, 1);
        break;
      case "--context":
        options.context_lines = cursor.integer(arg, 0);
        break;
      case "--include":
        include.push(cursor.value(arg));
        break;
      case "--exclude":
        exclude.push(cursor.value(arg));
        break;
      case "--ignore-case":
        options.ignore_case = true;
        break;
      case "--match-variants":
        options.match_variants = true;
        break;
      default:
        pathArg ??= arg;
    }
  }

  if (include.length > 0) options.include = include;
  if (exclude.length > 0) options.exclude = exclude;
  return { options, pathArg };
}

export interface ExpandArgs {
  before: number;
  after: number;
}

/** Parse `--before N` / `--after N` for `miru expand`. */
export function parseExpandArgs(args: readonly string[]): ExpandArgs {
  const result: ExpandArgs = { before: DEFAULT_EXPAND_BEFORE, after: DEFAULT_EXPAND_AFTER };
  const cursor = new ArgCursor(args, "expand");
  for (let arg = cursor.next(); arg !== undefined; arg = cursor.next()) {
    if (arg === "--before") result.before = cursor.integer(arg, 0);
    else if (arg === "--after") result.after = cursor.integer(arg, 0);
  }
  return result;
}

export interface InitArgs {
  agent?: string;
  force: boolean;
}

/** Parse `miru init` flags; agent validation stays with the caller, which owns the agent registry. */
export function parseInitArgs(args: readonly string[]): InitArgs {
  const result: InitArgs = { force: false };
  const cursor = new ArgCursor(args, "init");
  for (let arg = cursor.next(); arg !== undefined; arg = cursor.next()) {
    if (arg === "--force") result.force = true;
    else if (arg === "--agent" || arg === "-a") result.agent = cursor.value("--agent");
  }
  return result;
}

export interface McpArgs {
  ref: string | null;
  benchmark: boolean;
  content: ContentType[];
}

/** Parse `miru mcp` / legacy bare-server argv. */
export function parseMcpArgs(argv: readonly string[]): McpArgs {
  const { content, rest } = parseContentArgv([...argv]);
  const result: McpArgs = { ref: null, benchmark: false, content };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--benchmark" || arg === "--benchmark=true") result.benchmark = true;
    else if (arg === "--benchmark=false") result.benchmark = false;
    else if (arg === "--ref" && rest[i + 1]) result.ref = rest[++i] ?? null;
  }
  return result;
}
