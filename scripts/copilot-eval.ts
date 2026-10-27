/** Run `bun run scripts/copilot-eval.ts --help`. No model calls without --run --yes. */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COPILOT_SERVER_CONFIG } from "../src/installer/agents.ts";
import {
  type Arm,
  CASES,
  CORE_CASES,
  FIXTURE_VERSION,
  SOURCE_FILES,
} from "./copilot-eval/fixtures.ts";
import {
  applyFinalUsage,
  buildCommand,
  changedPaths,
  guardObservations,
  infrastructureError,
  mcpSetupError,
  parseTrace,
  prepareCopilotHome,
  type RunPlan,
  scoreCase,
  shuffled,
  snapshot,
  writeFixture,
} from "./copilot-eval/lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const SERVER = join(ROOT, "scripts/copilot-eval/mcp-server.ts");
const HELP = `Copilot agent evaluation (local synthetic repository; source-checkout Miru)

  bun run scripts/copilot-eval.ts --doctor
  bun run scripts/copilot-eval.ts --dry-run [--cases core|all|id,id]
  bun run scripts/copilot-eval.ts --run --yes --model MODEL [options]
  bun run scripts/copilot-eval.ts --rescore /absolute/path/to/report

Options:
  --cases core|all|id,id   Default: core (10 cases). all adds delegation and fault tests.
  --arms native,miru,agent Default: all three. Fault cases skip native.
  --repeats N             Default: 3 fresh sessions per case and arm.
  --backend real|fixture  Default: real. fixture is deterministic lexical retrieval,
                          for behavior/debugging only, NOT retrieval-quality evidence.
  --model MODEL           Required for live runs; auto is rejected for comparability.
  --allow-auto            Explicit exploratory mode for accounts with Auto only.
  --timeout N             Seconds per run, default 180. Stops the process group.
  --seed N                Deterministic order shuffle, default 42.
  --out DIR               New output directory; existing directories are never overwritten.

Native tools remain visible in the normal Miru arm; product routing hooks reject indexed search bypasses. Writes, shell, and web access are denied.
Raw session JSONL, OTel, usage JSON, MCP audit, source diffs and heuristic scores are saved.
Private Copilot homes contain auth references and are removed after each run.
No calls to Copilot or embedding APIs occur during --dry-run or --doctor.
`;

export function options(argv: string[]) {
  const flags = new Set(["--help", "--doctor", "--dry-run", "--run", "--yes", "--allow-auto"]);
  const values = new Set([
    "--cases",
    "--arms",
    "--repeats",
    "--backend",
    "--model",
    "--timeout",
    "--seed",
    "--out",
    "--rescore",
  ]);
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) opts.set(arg, "true");
    else if (values.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      opts.set(arg, value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = opts.get(key) ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
  const requested = opts.get("--cases") ?? "core";
  const cases =
    requested === "core"
      ? CORE_CASES
      : requested === "all"
        ? CASES
        : requested.split(",").map((id) => {
            const spec = CASES.find((c) => c.id === id);
            if (!spec) throw new Error(`Unknown case: ${id}`);
            return spec;
          });
  const arms = (opts.get("--arms") ?? "native,miru,agent").split(",") as Arm[];
  if (
    arms.some((a) => !["native", "miru", "agent"].includes(a)) ||
    new Set(arms).size !== arms.length
  )
    throw new Error("--arms must contain distinct native, miru or agent values");
  const backend = opts.get("--backend") ?? "real";
  if (!["real", "fixture"].includes(backend)) throw new Error("--backend must be real or fixture");
  const model = opts.get("--model");
  if (
    opts.has("--run") &&
    (!opts.has("--yes") || !model || (model.toLowerCase() === "auto" && !opts.has("--allow-auto")))
  )
    throw new Error(
      "Live evaluation requires --run --yes --model MODEL (a fixed model, not auto; exploratory Auto requires --allow-auto)",
    );
  const repeats = integer("--repeats", 3, 1, 100);
  const seed = integer("--seed", 42, 0, 0xffffffff);
  const plan = shuffled(
    cases.flatMap((spec) =>
      arms
        .filter((a) => !spec.fault || a !== "native")
        .flatMap((arm) =>
          Array.from({ length: repeats }, (_, i) => ({ arm, spec, repeat: i + 1 })),
        ),
    ),
    seed,
  );
  if (!plan.length) throw new Error("No applicable runs selected");
  return { opts, backend, model, repeats, seed, plan, timeout: integer("--timeout", 180, 1, 3600) };
}

async function commandOutput(command: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function doctor() {
  const version = await commandOutput(["copilot", "--version"]);
  const help = await commandOutput(["copilot", "--help"]);
  const required = [
    "--output-format",
    "--usage-output-file",
    "--additional-mcp-config",
    "--trust-folder",
    "--no-auto-update",
    "--excluded-tools",
    "--no-remote-export",
  ];
  const missing = required.filter((flag) => !help.includes(flag));
  console.log(
    JSON.stringify(
      {
        version,
        bun: Bun.version,
        missingFlags: missing,
        authentication:
          "Run copilot login if not already signed in; doctor does not spend model usage or verify plan entitlement.",
        miru: "Real mode uses local source and current Miru credentials. Fixture mode needs no embedding credentials.",
        cases: CASES.map((c) => c.id),
      },
      null,
      2,
    ),
  );
  if (missing.length)
    throw new Error("Installed Copilot lacks required flags; update it before evaluating");
  return version;
}

export function childEnvironment(privateHome: string, runDir: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of Object.keys(env)) {
    if (
      /^(COPILOT_PROVIDER_|OTEL_|COPILOT_OTEL_)/.test(key) ||
      [
        "COPILOT_ALLOW_ALL",
        "COPILOT_ASSISTED_APPROVAL",
        "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
        "COPILOT_SKILLS_DIRS",
        "COPILOT_OFFLINE",
        "BASH_ENV",
        "ENV",
      ].includes(key)
    )
      delete env[key];
  }
  return {
    ...env,
    COPILOT_HOME: privateHome,
    COPILOT_OTEL_FILE_EXPORTER_PATH: join(runDir, "otel.jsonl"),
    COPILOT_OTEL_EXPORTER_TYPE: "file",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    NO_COLOR: "1",
    MIRU_OPEN_BROWSER: "0",
  };
}

async function readOptional(path: string) {
  return Bun.file(path)
    .exists()
    .then((exists) => (exists ? Bun.file(path).text() : ""));
}

type RunResult = Awaited<ReturnType<typeof runOne>>;
async function runOne(plan: RunPlan, runDir: string, config: ReturnType<typeof options>) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const privateHome = await mkdtemp(join(tmpdir(), "miru-copilot-auth-"));
  const repo = join(runDir, "repo");
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (proc?.pid) process.kill(-proc.pid, signal);
    } catch {
      proc?.kill(signal);
    }
  };
  const interrupt = () => kill("SIGTERM");
  try {
    await writeFixture(repo);
    const configPath = join(runDir, "mcp-config.json");
    await prepareCopilotHome(
      privateHome,
      process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
      plan.arm,
      configPath,
    );
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            miru: {
              ...COPILOT_SERVER_CONFIG,
              command: process.execPath,
              args: [SERVER],
              env: {
                MIRU_EVAL_BACKEND: config.backend,
                MIRU_EVAL_FAULT: plan.spec.fault ?? "none",
                MIRU_EVAL_MCP_LOG: join(runDir, "mcp.jsonl"),
                MIRU_WORKSPACE_ROOT: repo,
                MIRU_OPEN_BROWSER: "0",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    if (plan.arm !== "native") {
      await writeFile(
        join(runDir, "routing-guard.js"),
        await readOptional(join(privateHome, "miru-routing", "guard.js")),
      );
      await writeFile(
        join(runDir, "routing.json"),
        JSON.stringify(
          {
            instructions: await readOptional(join(privateHome, "copilot-instructions.md")),
            agent: await readOptional(join(privateHome, "agents", "miru-code.agent.md")),
            hooks: JSON.parse(
              (await readOptional(join(privateHome, "hooks", "miru-routing.json"))) || "null",
            ),
            mcp: JSON.parse(await readFile(configPath, "utf8")),
          },
          null,
          2,
        ),
      );
    }
    if (!config.model) throw new Error("A model is required");
    const args = buildCommand({ model: config.model, plan, runDir, configPath });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(
        {
          arm: plan.arm,
          caseId: plan.spec.id,
          repeat: plan.repeat,
          prompt: plan.spec.prompt,
          args,
          backend: config.backend,
        },
        null,
        2,
      ),
    );
    const before = await snapshot(repo);
    await writeFile(join(runDir, "before.json"), JSON.stringify(before));
    const start = performance.now();
    proc = Bun.spawn(["copilot", ...args], {
      cwd: repo,
      env: childEnvironment(privateHome, runDir),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    process.on("SIGINT", interrupt);
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 1000);
    }, config.timeout * 1000);
    const [, , exitCode] = await Promise.all([
      Bun.write(join(runDir, "session.jsonl"), proc.stdout),
      Bun.write(join(runDir, "stderr.txt"), proc.stderr),
      proc.exited,
    ]);
    const wallMs = Math.round(performance.now() - start);
    // Kill descendants even when the parent exits normally; don't leave background agents running.
    kill("SIGTERM");
    const after = await snapshot(repo);
    await writeFile(join(runDir, "after.json"), JSON.stringify(after));
    const raw = await readOptional(join(runDir, "session.jsonl"));
    const trace = parseTrace(raw);
    applyFinalUsage(trace, await readOptional(join(runDir, "usage.json")));
    const mcp = await readOptional(join(runDir, "mcp.jsonl"));
    const guard = await readOptional(join(privateHome, "miru-routing", "audit.jsonl"));
    await writeFile(join(runDir, "guard.jsonl"), guard);
    const routingGuard = guardObservations(guard);
    let setupError = infrastructureError(
      trace,
      await readOptional(join(runDir, "stderr.txt")),
      exitCode,
      timedOut,
    );
    if (!plan.spec.fault && mcpSetupError(mcp)) setupError = "miru_index_or_credentials";
    if (!setupError && plan.arm !== "native" && (!routingGuard.active || routingGuard.errors))
      setupError = "routing_guard_inactive";
    const result = {
      arm: plan.arm,
      caseId: plan.spec.id,
      repeat: plan.repeat,
      backend: config.backend,
      requestedModel: config.model,
      wallMs,
      exitCode,
      setupError,
      evidence: {
        eventCount: trace.eventCount,
        invalidLines: trace.invalidLines,
        mcpCalls: mcp.split("\n").filter((l) => l.includes('"direction":"request"')).length,
        mcpInitialized: mcp.includes('"event":"initialized"'),
      },
      usage: trace.usage,
      billing: trace.billing,
      models: trace.models,
      tools: trace.tools,
      finalText: trace.finalText,
      ...scoreCase(plan.spec, plan.arm, trace, changedPaths(before, after), await realpath(repo)),
      routingGuard,
    };
    await writeFile(join(runDir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    process.off("SIGINT", interrupt);
    if (proc) kill("SIGKILL");
    await rm(privateHome, { recursive: true, force: true });
  }
}

function markdown(rows: RunResult[], backend: string) {
  const lines = [
    "# Copilot / Miru evaluation",
    "",
    `Backend: **${backend}**. ${backend === "fixture" ? "Synthetic lexical retrieval: behavior/debugging evidence only." : "Production Miru implementation from the local source checkout."}`,
    rows.some((r) => r.requestedModel?.toLowerCase() === "auto")
      ? "**Exploratory Auto routing: this is not a model-controlled comparison.**"
      : "Fixed requested model; check recorded actual models for unexpected routing.",
    "",
    "Answer checks are path/fact heuristics, not a semantic judge. Inspect raw answers before making quality claims. Missing usage is unknown, never zero. Source writes are blocked; attempts and changed files are reported separately.",
    "",
    "| Arm | Completed / runs | Answer checks passed | Correct first tool | Usage known | Mean input | Mean output | Median ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const average = (values: number[]) =>
    values.length ? Math.round(values.reduce((sum, n) => sum + n, 0) / values.length) : "unknown";
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
      : "unknown";
  };
  for (const arm of ["native", "miru", "agent"] as const) {
    const all = rows.filter((r) => r.arm === arm);
    if (!all.length) continue;
    const completed = all.filter((r) => !r.setupError);
    const eligible = completed.filter((r) => r.policy.firstToolCorrect !== null);
    const measured = completed.flatMap((r) => (r.usage ? [r.usage] : []));
    lines.push(
      `| ${arm} | ${completed.length}/${all.length} | ${completed.filter((r) => r.answerCheck.pass).length}/${completed.length} | ${eligible.length ? `${eligible.filter((r) => r.policy.firstToolCorrect).length}/${eligible.length}` : "n/a"} | ${measured.length}/${completed.length} | ${average(measured.map((u) => u.input))} | ${average(measured.map((u) => u.output))} | ${median(completed.map((r) => r.wallMs))} |`,
    );
  }
  lines.push(
    "",
    "Means use completed runs with known usage, including incorrect answers. Input is the provider's total input counter; cache reads/writes are separate fields in results.json, not extra tokens to add. These small fixtures do not establish a production savings percentage.",
    "",
    "| Arm | Cost known / attempts | Total reported AI credits | Mean credits / measured attempt |",
    "|---|---:|---:|---:|",
    ...(["native", "miru", "agent"] as const).flatMap((arm) => {
      const all = rows.filter((r) => r.arm === arm);
      if (!all.length) return [];
      const measured = all.flatMap((r) => (r.billing ? [r.billing.nanoAiu] : []));
      const total = measured.reduce((sum, value) => sum + value, 0) / 1e9;
      return [
        `| ${arm} | ${measured.length}/${all.length} | ${measured.length ? total.toFixed(4) : "unknown"} | ${measured.length ? (total / measured.length).toFixed(4) : "unknown"} |`,
      ];
    }),
    "",
    "Credit totals use complete CLI totalNanoAiu accounting, including child agents, cache costs, retries and any failed attempts with known cost. Missing/incomplete cost is unknown. AI credits = nano-AI units / 1e9; this is not invoice reconciliation and excludes Miru indexing/embedding costs.",
    "",
    "First-tool choices above include blocked attempts. Successful completions and unit-claim review candidates are separate:",
    "",
    "| Arm | Correct first executed tool | Native searches executed | Context violations attempted / executed | Unit-claim candidates | Guard-active sessions |",
    "|---|---:|---:|---:|---:|---:|",
    ...(["native", "miru", "agent"] as const).flatMap((arm) => {
      const all = rows.filter((r) => r.arm === arm && !r.setupError);
      if (!all.length) return [];
      const eligible = all.filter((r) => r.policy.firstExecutedToolCorrect !== null);
      const sum = (get: (r: RunResult) => number) => all.reduce((n, r) => n + get(r), 0);
      return [
        `| ${arm} | ${eligible.length ? `${eligible.filter((r) => r.policy.firstExecutedToolCorrect).length}/${eligible.length}` : "n/a"} | ${sum((r) => r.policy.nativeSearchExecuted)} | ${sum((r) => r.policy.contextViolationAttempts)} / ${sum((r) => r.policy.contextViolationsExecuted)} | ${sum((r) => r.policy.unsupportedUnitCandidates.length)} | ${sum((r) => (r.routingGuard.active ? 1 : 0))}/${all.length} |`,
      ];
    }),
    "",
    "| Arm | Case | Repeat | Setup | Answer check | First tool | Native before Miru | Write attempts | ms |",
    "|---|---|---:|---|---|---|---:|---:|---:|",
  );
  for (const row of rows)
    lines.push(
      `| ${row.arm} | ${row.caseId} | ${row.repeat} | ${row.setupError ?? "ok"} | ${row.setupError ? "unscored" : row.answerCheck.pass ? "pass" : "review"} | ${row.policy.firstToolCorrect ?? "n/a"} | ${row.policy.nativeBeforeMiru ?? "n/a"} | ${row.policy.writeAttempts} | ${row.wallMs} |`,
    );
  return `${lines.join("\n")}\n`;
}

async function rescore(out: string) {
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  if (
    manifest.fixtureVersion !== FIXTURE_VERSION ||
    manifest.fixtureHash !== createHash("sha256").update(JSON.stringify(SOURCE_FILES)).digest("hex")
  )
    throw new Error(
      "Saved corpus differs from the current fixtures; use the original harness revision to rescore.",
    );
  const rows = [];
  for (const run of manifest.runs) {
    const dir = join(out, run.directory);
    if (!(await Bun.file(join(dir, "result.json")).exists())) continue;
    const old = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    const spec = CASES.find((c) => c.id === old.caseId);
    if (!spec) throw new Error(`Unknown saved fixture ${old.caseId}`);
    const trace = parseTrace(await readOptional(join(dir, "session.jsonl")));
    applyFinalUsage(trace, await readOptional(join(dir, "usage.json")));
    let setupError = infrastructureError(
      trace,
      await readOptional(join(dir, "stderr.txt")),
      old.exitCode,
      old.setupError === "timeout",
    );
    if (!spec.fault && mcpSetupError(await readOptional(join(dir, "mcp.jsonl"))))
      setupError = "miru_index_or_credentials";
    const changed = changedPaths(
      JSON.parse(await readFile(join(dir, "before.json"), "utf8")),
      JSON.parse(await readFile(join(dir, "after.json"), "utf8")),
    );
    const row = {
      ...old,
      requestedModel: manifest.model,
      setupError,
      usage: trace.usage,
      billing: trace.billing,
      models: trace.models,
      tools: trace.tools,
      finalText: trace.finalText,
      ...scoreCase(spec, old.arm, trace, changed, await realpath(join(dir, "repo"))),
      routingGuard: guardObservations(await readOptional(join(dir, "guard.jsonl"))),
    };
    await writeFile(join(dir, "result.json"), JSON.stringify(row, null, 2));
    rows.push(row);
  }
  await writeFile(join(out, "results.json"), JSON.stringify(rows, null, 2));
  await writeFile(join(out, "report.md"), markdown(rows, manifest.backend));
  console.log(`Rescored ${rows.length} saved runs; no model or embedding calls.`);
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.opts.has("--help")) {
    console.log(HELP);
    return;
  }
  if (config.opts.has("--doctor")) {
    await doctor();
    return;
  }
  const savedReport = config.opts.get("--rescore");
  if (savedReport) {
    await rescore(resolve(savedReport));
    return;
  }
  if (!config.opts.has("--run")) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          backend: config.backend,
          model: config.model ?? "required for live runs",
          runs: config.plan.length,
          plan: config.plan.map((p) => ({ arm: p.arm, caseId: p.spec.id, repeat: p.repeat })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const version = await doctor();
  const out = resolve(
    config.opts.get("--out") ?? join(tmpdir(), `miru-copilot-eval-${Date.now()}`),
  );
  await mkdir(out, { mode: 0o700 }); // Deliberately fail if it exists.
  await chmod(out, 0o700);
  const sourceHash = createHash("sha256").update(JSON.stringify(SOURCE_FILES)).digest("hex");
  const runtimeHash = createHash("sha256");
  for (const path of [
    ...new Bun.Glob("src/**/*.{ts,md}").scanSync({ cwd: ROOT }),
    "scripts/copilot-eval.ts",
    "scripts/copilot-eval/lib.ts",
    "scripts/copilot-eval/fixtures.ts",
    "scripts/copilot-eval/mcp-server.ts",
    "package.json",
  ].sort()) {
    runtimeHash.update(path).update(await readFile(join(ROOT, path)));
  }
  const runs = config.plan.map((p, i) => ({
    directory: `${String(i + 1).padStart(3, "0")}-${p.arm}-${p.spec.id}-${p.repeat}`,
    arm: p.arm,
    caseId: p.spec.id,
    repeat: p.repeat,
  }));
  const manifest = {
    createdAt: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    fixtureHash: sourceHash,
    runtimeHash: runtimeHash.digest("hex"),
    version,
    model: config.model,
    comparison:
      config.model?.toLowerCase() === "auto"
        ? "exploratory-auto-not-model-controlled"
        : "fixed-model",
    backend: config.backend,
    seed: config.seed,
    revision: await commandOutput(["git", "rev-parse", "HEAD"]),
    dirtyPaths: await commandOutput(["git", "status", "--short"]),
    runtime: "local source checkout",
    policy:
      "current Copilot installer policy, upfront MCP tools, named specialist and routing hooks in Miru arms; hooks reject native indexed search and require bounded reads before expansion; specialist limits tools to read, agent and named Miru tools; native control has no Miru hooks; source writes and shell denied equally",
    limitations: [
      "Personal ~/.agents skill descriptions may still be advertised by Copilot; skill invocation is excluded.",
      "Read-only harness measures attempted mutation, not ability to resist mutation with full permissions.",
      "Path/fact answer oracle requires human review.",
      "Each fixture directory is fresh: timings include any index construction; not a warm-cache latency comparison.",
    ],
    runs,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  const rows: RunResult[] = [];
  console.log(`Writing evidence to ${out}`);
  for (let i = 0; i < config.plan.length; i++) {
    const row = await runOne(config.plan[i], join(out, runs[i].directory), config);
    rows.push(row);
    await writeFile(join(out, "results.json"), JSON.stringify(rows, null, 2));
    await writeFile(join(out, "report.md"), markdown(rows, config.backend));
    console.log(
      `[${i + 1}/${runs.length}] ${row.arm}/${row.caseId}: ${row.setupError ?? (row.answerCheck.pass ? "answer check passed" : "review answer")}`,
    );
    if (row.setupError) {
      console.error(`Stopped on ${row.setupError}; fix setup before spending usage on more runs.`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`Report: ${join(out, "report.md")}`);
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
