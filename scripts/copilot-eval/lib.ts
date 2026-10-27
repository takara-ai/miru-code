import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  contextDecision,
  type GuardState,
  readRange,
  recordHits,
} from "../../src/copilot/routing-guard.ts";
import { AGENT_TARGETS } from "../../src/installer/agents.ts";
import { stripJsonComments } from "../../src/installer/config.ts";
import { applyInstructions, applySubagent } from "../../src/installer/installer.ts";
import { type Arm, type FixtureCase, SOURCE_FILES } from "./fixtures.ts";

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  agentId?: string;
  success?: boolean;
  resultText?: string;
};
export type ParsedTrace = {
  finalText: string;
  tools: ToolCall[];
  errors: string[];
  eventCount: number;
  invalidLines: number;
  models: string[];
  /** Provider-reported session cost, including children; never inferred from tokens. */
  billing: { nanoAiu: number; status: "complete" } | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    source?: "session-events" | "cli-model-metrics";
  } | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parse documented Copilot session events; unknown formats never become zero-cost successes. */
export function parseTrace(raw: string): ParsedTrace {
  const result: ParsedTrace = {
    finalText: "",
    tools: [],
    errors: [],
    eventCount: 0,
    invalidLines: 0,
    models: [],
    billing: null,
    usage: null,
  };
  const seen = new Set<string>();
  const usageIds = new Set<string>();
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      result.invalidLines++;
      continue;
    }
    if (typeof event.type !== "string") continue;
    if (typeof event.id === "string" && seen.has(event.id)) continue;
    if (typeof event.id === "string") seen.add(event.id);
    const data = record(event.data) as {
      agentId?: string;
      parentToolCallId?: string;
      toolCallId?: string;
      toolName?: string;
      mcpServerName?: string;
      mcpToolName?: string;
      arguments?: unknown;
      success?: boolean;
      toolRequests?: unknown[];
      content?: string;
      message?: string;
      errorType?: string;
      apiCallId?: string;
      providerCallId?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      model?: string;
      result?: unknown;
    };
    const agentId =
      typeof event.agentId === "string" ? event.agentId : (data.agentId ?? data.parentToolCallId);
    result.eventCount++;
    if (
      (event.type === "assistant.usage" || event.type === "assistant.message") &&
      data.model &&
      !result.models.includes(data.model)
    )
      result.models.push(data.model);
    if (event.type === "tool.execution_start") {
      result.tools.push({
        id: data.toolCallId ?? `unknown-${result.tools.length}`,
        name: data.mcpServerName
          ? `${data.mcpServerName}/${data.mcpToolName ?? data.toolName}`
          : (data.toolName ?? "unknown"),
        args: record(data.arguments),
        agentId,
      });
    } else if (event.type === "tool.execution_complete") {
      const call = result.tools.find((t) => t.id === data.toolCallId);
      if (call) {
        call.success = data.success;
        const content = record(data.result).content;
        if (typeof content === "string") call.resultText = content;
      }
    } else if (event.type === "assistant.message" && !agentId && !data.toolRequests?.length) {
      if (typeof data.content === "string" && data.content.trim()) result.finalText = data.content;
    } else if (event.type === "session.error") {
      result.errors.push(String(data.message ?? data.errorType ?? "session error"));
    } else if (
      event.type === "assistant.usage" &&
      typeof data.inputTokens === "number" &&
      Number.isFinite(data.inputTokens) &&
      typeof data.outputTokens === "number" &&
      Number.isFinite(data.outputTokens)
    ) {
      const id =
        data.apiCallId ??
        data.providerCallId ??
        (typeof event.id === "string" ? event.id : undefined);
      if (id && usageIds.has(id)) continue;
      if (id) usageIds.add(id);
      result.usage ??= {
        input: 0,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        source: "session-events",
      };
      result.usage.input += data.inputTokens;
      result.usage.output += data.outputTokens;
      for (const [field, key] of [
        ["cacheRead", "cacheReadTokens"],
        ["cacheWrite", "cacheWriteTokens"],
      ] as const) {
        const value = data[key];
        if (typeof value === "number" && Number.isFinite(value))
          result.usage[field] = (result.usage[field] ?? 0) + value;
      }
    }
  }
  return result;
}

/** CLI final metrics include all agents; agentMetrics/providerModelMetrics are alternate breakdowns, not additive. */
export function applyFinalUsage(trace: ParsedTrace, raw: string): void {
  if (!raw.trim()) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(raw));
  } catch {
    return;
  }
  if (
    parsed.aiCreditsStatus === "complete" &&
    typeof parsed.totalNanoAiu === "number" &&
    Number.isFinite(parsed.totalNanoAiu) &&
    parsed.totalNanoAiu >= 0
  )
    trace.billing = { nanoAiu: parsed.totalNanoAiu, status: "complete" };
  const metrics = Object.entries(record(parsed.modelMetrics));
  if (!metrics.length) return;
  const usages = metrics.map(([, value]) => record(record(value).usage));
  if (
    usages.some(
      (u) =>
        typeof u.inputTokens !== "number" ||
        typeof u.outputTokens !== "number" ||
        !Number.isFinite(u.inputTokens) ||
        !Number.isFinite(u.outputTokens),
    )
  )
    return;
  const sum = (key: string): number | null =>
    usages.every((u) => typeof u[key] === "number" && Number.isFinite(u[key]))
      ? usages.reduce((n, u) => n + Number(u[key]), 0)
      : null;
  trace.usage = {
    input: sum("inputTokens") ?? 0,
    output: sum("outputTokens") ?? 0,
    cacheRead: sum("cacheReadTokens"),
    cacheWrite: sum("cacheWriteTokens"),
    source: "cli-model-metrics",
  };
  trace.models = metrics.map(([model]) => model);
}

export function miruTool(name: string): string | null {
  return /(?:^|[/_])miru(?:[/_-]|__)/i.test(name)
    ? (name.match(/(?:\/|__|_|-)(search|locate|expand|find_related|auth)$/)?.[1] ?? null)
    : null;
}

export function nativeSearch(name: string): boolean {
  return (
    !miruTool(name) &&
    /(?:^|\/)(grep|rg|grep_search|glob|codebase_search|file_search|semantic_search)$/i.test(name)
  );
}

export function guardObservations(raw: string) {
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  const denials = events.filter((e) => e.decision === "deny");
  return {
    active: events.some((e) => e.event === "start"),
    events: events.length,
    errors: events.filter((e) => e.event === "error").length,
    denials,
  };
}

export function unitClaimCandidates(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        /\b(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|years?)\b/i.test(sentence) &&
        !/\b(?:unspecified|not specified|not state|doesn.t state|does not specify|not declare|not defined|unknown|no units?|without units?)\b/i.test(
          sentence,
        ),
    );
}

export function contextViolations(trace: ParsedTrace, repo: string) {
  const states = new Map<string, GuardState>();
  const violations: ToolCall[] = [];
  const indexed = new Set(
    Object.keys(SOURCE_FILES)
      .filter((p) => !p.startsWith("generated/"))
      .map((p) => join(repo, p)),
  );
  for (const call of trace.tools) {
    const key = call.agentId ?? "root";
    const state = states.get(key) ?? { hits: [], known: [] };
    states.set(key, state);
    if (contextDecision(call.name, call.args, repo, state, indexed).permissionDecision === "deny")
      violations.push(call);
    if (call.success !== true) continue;
    if (miruTool(call.name) && call.resultText) recordHits(call.resultText, repo, state);
    if (/^(view|read_file|read)$/.test(call.name)) {
      const path = String(call.args.path ?? call.args.filePath ?? call.args.file_path ?? "");
      const range = readRange(call.args);
      if (range)
        for (const hit of state.hits)
          if (
            (hit.file === path || hit.file === join(repo, path)) &&
            range[0] <= hit.start &&
            range[1] >= hit.end
          )
            hit.read = true;
    }
  }
  return violations;
}

export function scoreCase(
  spec: FixtureCase,
  arm: Arm,
  trace: ParsedTrace,
  changedFiles: string[],
  repo?: string,
) {
  const text = trace.finalText.toLowerCase();
  const missingFiles = spec.expectedFiles.filter((f) => !text.includes(f.toLowerCase()));
  const missingFacts = spec.facts.filter(
    (group) => !group.some((fact) => text.includes(fact.toLowerCase())),
  );
  const firstExploration = trace.tools.find(
    (t) =>
      nativeSearch(t.name) || miruTool(t.name) || /(?:^|\/)(view|read_file|read)$/i.test(t.name),
  );
  const miruCalls = trace.tools.filter((t) => miruTool(t.name));
  const firstExecuted = trace.tools.find(
    (t) =>
      t.success === true &&
      (nativeSearch(t.name) || miruTool(t.name) || /(?:^|\/)(view|read_file|read)$/i.test(t.name)),
  );
  const context = repo && arm !== "native" ? contextViolations(trace, repo) : [];
  const firstMiruIndex = trace.tools.findIndex((t) =>
    ["search", "locate"].includes(miruTool(t.name) ?? ""),
  );
  const nativeBeforeMiru = trace.tools.filter(
    (t, i) => nativeSearch(t.name) && (firstMiruIndex < 0 || i < firstMiruIndex),
  );
  const speculativeAuth = miruCalls.filter((t) => miruTool(t.name) === "auth" && !spec.fault);
  const writeAttempts = trace.tools.filter((t) =>
    /(?:^|\/)(edit|create|apply_patch|write_file|str_replace_editor)$/i.test(t.name),
  );
  const shellAttempts = trace.tools.filter((t) =>
    /(?:^|\/)(bash|powershell|shell|execute)$/i.test(t.name),
  );
  const broadReads = trace.tools.filter((t) => {
    if (!/(?:^|\/)(view|read_file|read)$/i.test(t.name)) return false;
    const path = String(t.args.path ?? t.args.filePath ?? t.args.file_path ?? "");
    return (
      path.endsWith("src/long-policy.ts") &&
      !t.args.view_range &&
      t.args.start_line == null &&
      t.args.offset == null
    );
  });
  const delegated = trace.tools.some(
    (t) => /(?:^|\/)(task|agent|runSubagent|search_code_subagent)$/i.test(t.name) || !!t.agentId,
  );
  return {
    // This checks cited paths/facts, not semantic equivalence; retain raw answers for review.
    answerCheck: {
      pass: !!trace.finalText && !missingFiles.length && !missingFacts.length,
      missingFiles,
      missingFacts,
    },
    policy: {
      applicable: arm !== "native",
      firstToolCorrect:
        arm === "native" || !spec.firstTool
          ? null
          : miruTool(firstExploration?.name ?? "") === spec.firstTool,
      firstExecutedToolCorrect:
        arm === "native" || !spec.firstTool
          ? null
          : miruTool(firstExecuted?.name ?? "") === spec.firstTool,
      nativeBeforeMiru:
        spec.fallback || spec.fault || arm === "native" ? null : nativeBeforeMiru.length,
      desiredToolUsed:
        arm === "native" || !spec.desiredTool
          ? null
          : miruCalls.some((t) => miruTool(t.name) === spec.desiredTool),
      nativeSearchCalls: trace.tools.filter((t) => nativeSearch(t.name)).length,
      nativeSearchExecuted: trace.tools.filter((t) => nativeSearch(t.name) && t.success === true)
        .length,
      repositoryScopeRejections: trace.tools.filter((t) =>
        /Evaluation tools may only inspect|Local repo path is outside workspace|repo path does not exist/.test(
          t.resultText ?? "",
        ),
      ).length,
      contextViolationAttempts: context.length,
      contextViolationsExecuted: context.filter((t) => t.success === true).length,
      unsupportedUnitCandidates: spec.unitlessNumbers ? unitClaimCandidates(trace.finalText) : [],
      speculativeAuth: speculativeAuth.length,
      broadReadCandidates: broadReads.length,
      repeatedSearches: Math.max(
        0,
        miruCalls.filter((t) => miruTool(t.name) === "search").length - 1,
      ),
      faultExercised: spec.fault ? miruCalls.length > 0 : null,
      recoveryBounded: spec.fault && miruCalls.length ? miruCalls.length <= 3 : null,
      delegated: spec.delegate ? delegated : null,
      childToolEvents: trace.tools.filter((t) => t.agentId).length,
      childMiruCalls: trace.tools.filter((t) => t.agentId && miruTool(t.name)).length,
      childNativeSearchCalls: trace.tools.filter((t) => t.agentId && nativeSearch(t.name)).length,
      builtInSearchDelegations: trace.tools.filter((t) => t.name === "search_code_subagent").length,
      writeAttempts: writeAttempts.length,
      shellAttempts: shellAttempts.length,
      changedFiles,
    },
  };
}

/** Full source-tree snapshot, including ignored and newly created files. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".miru") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        hashes[relative(root, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      else hashes[relative(root, path).replaceAll("\\", "/")] = "non-regular-file";
    }
  }
  await walk(root);
  return hashes;
}

export function changedPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

export async function writeFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(SOURCE_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const proc = Bun.spawn(["git", "-c", "init.defaultBranch=main", "init", "--quiet", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (await proc.exited) throw new Error(await new Response(proc.stderr).text());
}

export function shuffled<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Copy authentication references only, never personal prompts, plugins, MCP servers or permissions. */
export async function prepareCopilotHome(
  destination: string,
  source: string,
  arm: Arm,
  mcpConfigPath?: string,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(stripJsonComments(await readFile(join(source, "config.json"), "utf8")));
  } catch (error) {
    if (record(error).code !== "ENOENT") throw error;
  }
  const auth = Object.fromEntries(
    Object.entries(config).filter(([key]) =>
      /^(logged_?in_?users|last_?logged_?in_?user|auth.*|.*token.*|.*account.*)$/i.test(key),
    ),
  );
  await writeFile(join(destination, "config.json"), JSON.stringify(auth), { mode: 0o600 });
  await writeFile(
    join(destination, "settings.json"),
    JSON.stringify({ memory: false, autoUpdate: false, customAgents: { defaultLocalOnly: true } }),
  );
  if (arm !== "native") {
    const copilot = AGENT_TARGETS.find((target) => target.id === "copilot");
    if (!copilot) throw new Error("Missing Copilot installer target");
    const target = {
      ...copilot,
      mcp: copilot.mcp
        ? { ...copilot.mcp, path: mcpConfigPath ?? join(destination, "mcp-config.json") }
        : null,
      instructionsPath: join(destination, "copilot-instructions.md"),
      subagentPath: join(destination, "agents", "miru-code.agent.md"),
    };
    await applyInstructions(target, "install");
    await applySubagent(target, "install");
  }
}

export type RunPlan = { arm: Arm; spec: FixtureCase; repeat: number };
export function buildCommand(options: {
  model: string;
  plan: RunPlan;
  runDir: string;
  configPath: string;
}): string[] {
  const { model, plan, runDir, configPath } = options;
  const args = [
    "-p",
    `${plan.spec.prompt}\n\nDo not change any files. Include source paths and line numbers when reporting code.`,
    "--model",
    model,
    "--output-format=json",
    "--no-auto-update",
    "--no-ask-user",
    "--no-color",
    "--no-bash-env",
    "--no-remote",
    "--no-remote-export",
    "--disable-builtin-mcps",
    "--trust-folder",
    "--disallow-temp-dir",
    "--log-dir",
    join(runDir, "logs"),
    "--usage-output-file",
    join(runDir, "usage.json"),
    // Native tools remain visible. Mutations, shell commands and web access are denied, not silently removed.
    "--deny-tool=write",
    "--deny-tool=shell",
    "--deny-tool=url",
    "--excluded-tools=skill",
  ];
  if (plan.arm !== "native")
    args.push("--additional-mcp-config", `@${configPath}`, "--allow-tool=miru");
  if (plan.arm === "agent") args.push("--agent=miru-code");
  return args;
}

export function infrastructureError(
  trace: ParsedTrace,
  stderr: string,
  exitCode: number,
  timedOut: boolean,
): string | null {
  if (timedOut) return "timeout";
  const combined = `${stderr}\n${trace.errors.join("\n")}`;
  if (/rate.?limit|quota|insufficient.*credit|usage limit/i.test(combined))
    return "quota_or_rate_limit";
  if (
    /not.*authenticat|login required|not logged|authentication.*fail|sign in|403|401/i.test(
      combined,
    )
  )
    return "authentication";
  if (/model.*not available|model.*not supported/i.test(combined)) return "model_unavailable";
  if (exitCode !== 0) return `exit_${exitCode}`;
  if (trace.errors.length) return "session_error";
  if (!trace.eventCount || !trace.finalText) return "unrecognized_or_incomplete_trace";
  return null;
}

export function mcpSetupError(raw: string): boolean {
  return /Failed to index|Takara credentials required|Miru could not authorize|Embedding API error/.test(
    raw,
  );
}
