/** Copilot CLI hooks. Bundled by the installer; no embedding or model calls. */
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { walkFiles } from "../index/file-walker.ts";
import { getExtensions, getFileStatus } from "../index/files.ts";
import { defaultContentTypes } from "../types.ts";

type Args = Record<string, unknown>;
export type Hit = { file: string; start: number; end: number; read: boolean };
export type GuardState = { hits: Hit[]; known: string[] };
export const EVIDENCE_GUIDANCE =
  "Answer from sufficient displayed source; stop reading. Missing context: view only the header's range before expand. " +
  "Analogous code: use find_related(file_path,anchor_line), not search. " +
  "Units require source evidence; otherwise give bare values (unit unspecified).";

function object(value: unknown): Args {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

export function miruOperation(name: string): string | null {
  return /(?:^|[/_-])miru(?:[/_-]|__)/i.test(name)
    ? (name.match(/(?:\/|__|_|-)(search|locate|expand|find_related|auth)$/)?.[1] ?? null)
    : null;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

/** Parse source headers, never source comments, into bounded context permissions. */
export function recordHits(text: string, root: string, state: GuardState): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i] ?? "";
    // search headers, locate's inline single-hit form, and grouped locate
    // file headers followed by numbered lines are all production formats.
    const match = header.match(/^([^\n]+?):(\d+)(?:-(\d+))?(?: \[.*\])?(?:: .*)?$/);
    const grouped = /^[\w./\\ -]+$/.test(header) && /^\s*\d+:/.test(lines[i + 1] ?? "");
    if (!match?.[1] && !grouped) continue;
    const file = resolve(root, match?.[1] ?? header);
    if (!within(root, file)) continue;
    let start = match?.[2] ? Number(match[2]) : Infinity;
    let end = Number(match?.[3] ?? match?.[2] ?? 0);
    // locate reports a match line plus numbered context rather than a chunk range.
    if (!match?.[3]) {
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]?.match(/^\s*(\d+):/);
        if (!line) break;
        start = Math.min(start, Number(line[1]));
        end = Math.max(end, Number(line[1]));
      }
    }
    if (!Number.isFinite(start) || end < start) continue;
    if (!state.hits.some((h) => h.file === file && h.start === start && h.end === end))
      state.hits.push({ file, start, end, read: false });
    if (!state.known.includes(file)) state.known.push(file);
  }
  // locate(mode=files) has no line ranges. A later bounded read is still allowed.
  for (const line of lines) {
    if (!/^(?:[\w./\\ -]+\.[\w-]+|(?:.*[/\\])?Dockerfile)$/i.test(line)) continue;
    const file = resolve(root, line);
    if (within(root, file) && !state.known.includes(file)) state.known.push(file);
  }
  state.hits = state.hits.slice(-100);
  state.known = state.known.slice(-200);
}

export function readRange(args: Args): [number, number] | null {
  const range = args.view_range;
  if (Array.isArray(range) && range.length === 2 && range.every(Number.isInteger))
    return Number(range[0]) > 0 && Number(range[1]) >= Number(range[0])
      ? [Number(range[0]), Number(range[1])]
      : null;
  const start = args.startLine ?? args.start_line ?? args.offset;
  const end =
    args.endLine ??
    args.end_line ??
    (typeof start === "number" && typeof args.limit === "number"
      ? start + args.limit - 1
      : undefined);
  return Number.isInteger(start) &&
    Number.isInteger(end) &&
    Number(start) > 0 &&
    Number(end) >= Number(start)
    ? [Number(start), Number(end)]
    : null;
}

function readPath(args: Args, root: string): string {
  return resolve(root, String(args.path ?? args.filePath ?? args.file_path ?? ""));
}

const NATIVE_SEARCH = /^(?:grep|rg|glob|grep_search|file_search|codebase_search|semantic_search)$/i;
const READ = /^(?:view|read_file|read)$/i;
const deny = (reason: string) => ({
  permissionDecision: "deny",
  permissionDecisionReason: `Miru routing: ${reason}`,
});

export function contextDecision(
  name: string,
  args: Args,
  root: string,
  state: GuardState,
  indexed: Set<string>,
): Args {
  if (miruOperation(name) === "expand") {
    const file = resolve(root, String(args.file_path ?? ""));
    const hits = state.hits.filter((h) => h.file === file);
    const anchor = Number(args.anchor_line);
    if (
      hits.some((h) => h.read) &&
      !hits.some((h) => h.read && anchor >= h.start && anchor <= h.end)
    )
      return deny(
        "Expand must use an anchor inside the source range already read. Locate a different target first.",
      );
    if (!hits.some((h) => h.read)) {
      const hit = hits[0];
      return deny(
        hit
          ? `Read ${relative(root, file)} lines ${hit.start}-${hit.end} with view_range first, or answer from the displayed source. Expand is only a fallback after that read.`
          : "Locate the file first, then read its reported line range before expanding neighbouring chunks.",
      );
    }
  }
  if (READ.test(name)) {
    const file = readPath(args, root);
    if (!indexed.has(file) && [...indexed].some((path) => within(file, path)))
      return deny(
        "Use miru/locate for filenames or miru/search for a conceptual question instead of listing an indexed directory with view.",
      );
    if (!indexed.has(file)) return {};
    if (!state.known.includes(file))
      return deny("Locate this indexed path with Miru before reading it.");
    const range = readRange(args);
    const hits = state.hits.filter((h) => h.file === file);
    if (
      !range ||
      (hits.length
        ? !hits.some((h) => range[0] >= h.start && range[1] <= h.end)
        : range[1] - range[0] >= 200)
    ) {
      const hit = hits[0];
      return deny(
        hit
          ? `Use view_range [${hit.start}, ${hit.end}] for ${relative(root, file)}; do not read the whole file or enlarge the reported range.`
          : "Use an explicit range of at most 200 lines for this located file.",
      );
    }
  }
  return {};
}

/** Whether a native search could inspect an indexed file. Uses the real walker. */
export function searchesIndex(
  name: string,
  args: Args,
  root: string,
  indexed: Set<string>,
): boolean {
  if (!NATIVE_SEARCH.test(name)) return false;
  const raw = args.paths ?? args.path ?? args.directory ?? args.folderPath;
  const bases = Array.isArray(raw) ? raw.map(String) : [typeof raw === "string" ? raw : "."];
  const filter =
    typeof args.includePattern === "string"
      ? args.includePattern
      : name === "file_search"
        ? args.query
        : name === "glob"
          ? args.pattern
          : undefined;
  return bases.some((base) => {
    const absolute = resolve(root, base);
    const hasGlob = /[*?{[]/.test(base);
    let glob: Bun.Glob | undefined;
    try {
      if (hasGlob) glob = new Bun.Glob(base.replaceAll("\\", "/"));
    } catch {
      return true;
    }
    for (const file of indexed) {
      const rel = relative(root, file).replaceAll("\\", "/");
      if (
        glob
          ? !glob.match(isAbsolute(base) ? file : rel)
          : file !== absolute && !within(absolute, file)
      )
        continue;
      if (typeof filter === "string") {
        try {
          if (!new Bun.Glob(filter).match(rel)) continue;
        } catch {
          return true;
        }
      }
      return true;
    }
    return false;
  });
}

async function rootFor(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return realpath((await proc.exited) === 0 && out ? out : cwd);
}

export async function indexedPaths(root: string): Promise<Set<string>> {
  const indexed = new Set<string>();
  for await (const path of walkFiles(root, getExtensions(defaultContentTypes()))) {
    if ((await getFileStatus(path)) === "valid") indexed.add(path);
  }
  return indexed;
}

async function main() {
  const event = process.argv[2];
  // Keep this bundled helper independent of installer modules and their global
  // path discovery, while accepting the installer's comment-preserving JSONC.
  const configText = await readFile(process.argv[3] ?? "", "utf8");
  const json = configText.replace(
    /("(?:\\[\s\S]|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  const config = object(JSON.parse(json));
  const server = object(object(config.mcpServers).miru);
  if (
    !Object.keys(server).length ||
    server.disabled === true ||
    (Array.isArray(server.tools) && !server.tools.length)
  )
    return {};
  const input = object(JSON.parse(await Bun.stdin.text()));
  if (typeof input.cwd !== "string" || typeof input.sessionId !== "string") return {};
  const root = await rootFor(input.cwd);
  const folder = join(dirname(import.meta.path), "state");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const session = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 24);
  const agent = createHash("sha256")
    .update(String(input.agentId ?? "root"))
    .update(root)
    .digest("hex")
    .slice(0, 24);
  const path = join(folder, `${session}-${agent}.json`);
  let state: GuardState = { hits: [], known: [] };
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* fresh session/agent */
  }
  const name = String(input.toolName ?? "");
  const args = object(input.toolArgs);
  // macOS /tmp and /var aliases, and symlinked working directories, must refer
  // to the same indexed file and context permission.
  for (const key of ["path", "paths", "filePath", "file_path", "directory", "folderPath"]) {
    const normalize = async (value: string) => {
      try {
        return await realpath(resolve(root, value));
      } catch {
        return value;
      }
    };
    const value = args[key];
    if (typeof value === "string") args[key] = await normalize(value);
    else if (Array.isArray(value))
      args[key] = await Promise.all(value.map((v) => (typeof v === "string" ? normalize(v) : v)));
  }
  let scope = root;
  let invalidRepo = false;
  if (typeof args.repo === "string") {
    try {
      scope = await realpath(resolve(root, args.repo));
    } catch {
      invalidRepo = true;
    }
  }
  let output: Args = {};
  if (event === "pre") {
    const indexed =
      NATIVE_SEARCH.test(name) ||
      READ.test(name) ||
      name === "task" ||
      name === "search_code_subagent"
        ? await indexedPaths(root)
        : new Set<string>();
    if (invalidRepo && miruOperation(name))
      output = deny(
        "The repo path does not exist. Omit repo for the current repository; for another repository copy its exact existing path.",
      );
    else if (searchesIndex(name, args, root, indexed))
      output = deny(
        "Use miru/locate for exact text, regex or filenames, or miru/search for a conceptual question. Native search is reserved for unindexed paths or outside this repository.",
      );
    else if (
      (name === "search_code_subagent" || (name === "task" && args.agent_type === "explore")) &&
      indexed.size
    )
      output = deny(
        "Delegate code investigation with task agent_type=miru-code, preserving the repository and read-only constraints.",
      );
    else output = contextDecision(name, args, scope, state, indexed);
  } else if (event === "post") {
    const lock = `${path}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lock);
        acquired = true;
        break;
      } catch (error) {
        if (object(error).code !== "EEXIST") throw error;
        await Bun.sleep(5);
      }
    }
    if (!acquired) throw new Error("Context state busy");
    try {
      // Parallel reads can finish together. Merge against the latest state under
      // the lock instead of losing another successful range-read permission.
      try {
        state = JSON.parse(await readFile(path, "utf8"));
      } catch {
        /* first result */
      }
      const result = object(input.toolResult);
      if (miruOperation(name) && miruOperation(name) !== "auth") {
        recordHits(String(result.textResultForLlm ?? ""), scope, state);
        if (args.mode !== "files" && args.mode !== "count" && state.hits.length)
          output = { additionalContext: EVIDENCE_GUIDANCE };
      } else if (READ.test(name)) {
        const file = readPath(args, root);
        const range = readRange(args);
        if (range && result.resultType === "success")
          for (const hit of state.hits)
            if (hit.file === file && range[0] <= hit.start && range[1] >= hit.end) hit.read = true;
        if (state.known.includes(file)) output = { additionalContext: EVIDENCE_GUIDANCE };
      }
      await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  } else if (event === "start" || event === "end") {
    for (const entry of await readdir(folder)) {
      const candidate = join(folder, entry);
      if (
        (event === "end" && entry.startsWith(`${session}-`)) ||
        Date.now() - (await stat(candidate)).mtimeMs > 86400000
      )
        await rm(candidate, { recursive: true, force: true });
    }
  }
  const audit = join(dirname(import.meta.path), "audit.jsonl");
  try {
    if ((await stat(audit)).size > 1_000_000) await writeFile(audit, "", { mode: 0o600 });
  } catch {
    /* first event */
  }
  await appendFile(
    audit,
    `${JSON.stringify({ event, session, agent, tool: name, decision: output.permissionDecision ?? null, reason: output.permissionDecisionReason ?? null })}\n`,
    { mode: 0o600 },
  );
  return output;
}

if (import.meta.main) {
  // This routing helper is not a security boundary. Missing config/state must not
  // break unrelated Copilot tools; never print diagnostics as malformed hook JSON.
  try {
    console.log(JSON.stringify(await main()));
  } catch {
    try {
      await appendFile(
        join(dirname(import.meta.path), "audit.jsonl"),
        `${JSON.stringify({ event: "error", phase: process.argv[2] })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* no installed assets */
    }
    console.log("{}");
  }
}
