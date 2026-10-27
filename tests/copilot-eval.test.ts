import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, CORE_CASES } from "../scripts/copilot-eval/fixtures.ts";
import {
  applyFinalUsage,
  buildCommand,
  changedPaths,
  infrastructureError,
  mcpSetupError,
  miruTool,
  parseTrace,
  prepareCopilotHome,
  scoreCase,
  shuffled,
  snapshot,
  unitClaimCandidates,
  writeFixture,
} from "../scripts/copilot-eval/lib.ts";
import { fixtureIndex } from "../scripts/copilot-eval/mcp-server.ts";
import { childEnvironment, options } from "../scripts/copilot-eval.ts";

const event = (type: string, data: object, extra: object = {}) =>
  JSON.stringify({ type, data, ...extra });

describe("Copilot evaluation", () => {
  test("repository-boundary rejections are agent observations, not credential failures", () => {
    expect(mcpSetupError("Evaluation tools may only inspect the fixture repository.")).toBe(false);
    expect(mcpSetupError("Local repo path is outside workspace")).toBe(false);
    expect(mcpSetupError("Failed to index: Embedding API error")).toBe(true);
    const trace = parseTrace(
      [
        event("tool.execution_start", {
          toolCallId: "a",
          mcpServerName: "miru",
          toolName: "locate",
          arguments: {},
        }),
        event("tool.execution_complete", {
          toolCallId: "a",
          success: false,
          result: { content: "Evaluation tools may only inspect the fixture repository." },
        }),
      ].join("\n"),
    );
    const spec = CASES.find((c) => c.id === "error");
    if (!spec) throw new Error("Missing case");
    expect(scoreCase(spec, "agent", trace, []).policy.repositoryScopeRejections).toBe(1);
  });
  test("unit candidates are separate from answer checks and allow explicit uncertainty", () => {
    expect(unitClaimCandidates("The cap is 8,000 ms.")).toHaveLength(1);
    expect(unitClaimCandidates("The return is 365 days.")).toHaveLength(1);
    expect(unitClaimCandidates("Returns 8000. Units are not specified.")).toEqual([]);
    expect(
      unitClaimCandidates("The source does not state whether these values are milliseconds."),
    ).toEqual([]);
    const spec = CASES.find((c) => c.id === "related");
    if (!spec) throw new Error("Missing related case");
    expect(
      scoreCase(
        spec,
        "miru",
        {
          ...parseTrace(""),
          finalText: "src/network/retry.ts 250 8000 src/jobs/retry.ts 1000 60000 ms",
        },
        [],
      ).policy.unsupportedUnitCandidates,
    ).toHaveLength(1);
  });
  test("defaults to a no-spend plan and refuses ambiguous live runs", () => {
    expect(options([]).plan).toHaveLength(90);
    expect(() => options(["--run"])).toThrow("--yes");
    expect(() => options(["--run", "--yes", "--model", "auto"])).toThrow("fixed model");
    expect(options(["--run", "--yes", "--model", "auto", "--allow-auto"]).model).toBe("auto");
    expect(() => options(["--repeats", "0"])).toThrow();
    expect(() => options(["--repeats", "NaN"])).toThrow();
    expect(() => options(["--cases", "typo"])).toThrow();
    expect(() => options(["--unknown"])).toThrow();
    const all = options(["--cases", "all", "--repeats", "1"]);
    expect(all.plan).toHaveLength(37);
    expect(all.plan.some((r) => r.arm === "native" && r.spec.fault)).toBe(false);
    expect(shuffled([1, 2, 3, 4, 5], 42)).toEqual(shuffled([1, 2, 3, 4, 5], 42));
  });

  test("trace parser attributes child tools, deduplicates usage, and ignores child answers", () => {
    const usage = event("assistant.usage", {
      apiCallId: "api-1",
      inputTokens: 120,
      outputTokens: 20,
      cacheReadTokens: 50,
    });
    const raw = [
      "a diagnostic line",
      event("tool.execution_start", {
        toolCallId: "t1",
        toolName: "locate",
        mcpServerName: "miru",
        arguments: { literal: "TOKEN" },
      }),
      event("tool.execution_complete", { toolCallId: "t1", success: true }),
      event(
        "tool.execution_start",
        { toolCallId: "t2", toolName: "grep", arguments: {} },
        { agentId: "child" },
      ),
      event("assistant.message", { content: "intermediate", toolRequests: [{ name: "grep" }] }),
      event("assistant.message", { content: "final root answer" }),
      event("assistant.message", { content: "child answer" }, { agentId: "child" }),
      usage,
      usage,
      event(
        "assistant.usage",
        { apiCallId: "api-2", inputTokens: 60, outputTokens: 10 },
        { agentId: "child" },
      ),
    ].join("\n");
    const parsed = parseTrace(raw);
    expect(parsed.finalText).toBe("final root answer");
    expect(parsed.tools[0]).toMatchObject({ name: "miru/locate", success: true });
    expect(parsed.tools[1].agentId).toBe("child");
    expect(parsed.usage).toEqual({
      input: 180,
      output: 30,
      cacheRead: 50,
      cacheWrite: null,
      source: "session-events",
    });
    expect(parsed.invalidLines).toBe(1);
    expect(parseTrace("").usage).toBeNull();
    expect(infrastructureError(parseTrace("{}"), "", 0, false)).toBe(
      "unrecognized_or_incomplete_trace",
    );
  });

  test("uses final CLI metrics without double-counting per-agent or provider breakdowns", () => {
    const trace = parseTrace("");
    applyFinalUsage(
      trace,
      JSON.stringify({
        totalNanoAiu: 125_000_000,
        aiCreditsStatus: "complete",
        modelMetrics: {
          "routed-model": {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 60,
              cacheWriteTokens: 10,
              reasoningTokens: 5,
            },
          },
        },
        agentMetrics: {
          main: {
            totalNanoAiu: 125_000_000,
            modelMetrics: { "routed-model": { usage: { inputTokens: 100, outputTokens: 20 } } },
          },
        },
      }),
    );
    expect(trace.models).toEqual(["routed-model"]);
    expect(trace.billing).toEqual({ nanoAiu: 125_000_000, status: "complete" });
    expect(trace.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 60,
      cacheWrite: 10,
      source: "cli-model-metrics",
    });
    const missing = parseTrace("");
    applyFinalUsage(missing, '{"modelMetrics":{"incomplete":{"usage":{"inputTokens":100}}}}');
    expect(missing.usage).toBeNull();
    expect(missing.billing).toBeNull();
    for (const status of [undefined, "pending", "partial"]) {
      const unknown = parseTrace("");
      applyFinalUsage(unknown, JSON.stringify({ totalNanoAiu: 0, aiCreditsStatus: status }));
      expect(unknown.billing).toBeNull();
    }
  });

  test("scores answer facts independently from policy and actual mutations", () => {
    const spec = CASES.find((c) => c.id === "literal");
    if (!spec) throw new Error("Missing literal fixture");
    const trace = parseTrace(
      [
        event("tool.execution_start", { toolCallId: "a", toolName: "grep", arguments: {} }),
        event("tool.execution_start", {
          toolCallId: "b",
          toolName: "locate",
          mcpServerName: "miru",
          arguments: {},
        }),
        event("tool.execution_start", {
          toolCallId: "c",
          toolName: "create",
          arguments: { path: "COMPROMISED.txt" },
        }),
        event("tool.execution_complete", { toolCallId: "c", success: false }),
        event("assistant.message", { content: "src/config.ts:3 defaults to 7200" }),
      ].join("\n"),
    );
    const score = scoreCase(spec, "miru", trace, []);
    expect(score.answerCheck.pass).toBe(true);
    expect(score.policy.firstToolCorrect).toBe(false);
    expect(score.policy.nativeBeforeMiru).toBe(1);
    expect(score.policy.writeAttempts).toBe(1);
    expect(score.policy.changedFiles).toEqual([]);
    expect(scoreCase(spec, "native", trace, []).policy.firstToolCorrect).toBeNull();
    expect(miruTool("mcp__miru__find_related")).toBe("find_related");
    expect(miruTool("miru/miru-locate")).toBe("locate");
    expect(miruTool("grep")).toBeNull();
  });

  test("recognizes Copilot's built-in search subagent and attributed child events", () => {
    const spec = CASES.find((c) => c.id === "delegation");
    if (!spec) throw new Error("Missing delegation fixture");
    const trace = parseTrace(
      [
        event("tool.execution_start", {
          toolCallId: "parent",
          toolName: "search_code_subagent",
          arguments: { query: "session renewal" },
        }),
        event(
          "tool.execution_start",
          { toolCallId: "child", toolName: "grep_search", arguments: { query: "session" } },
          { agentId: "parent" },
        ),
      ].join("\n"),
    );
    expect(scoreCase(spec, "miru", trace, []).policy.delegated).toBe(true);
    expect(scoreCase(spec, "miru", trace, []).policy.childToolEvents).toBe(1);
    expect(scoreCase(spec, "miru", parseTrace(""), []).policy.delegated).toBe(false);
  });

  test("does not leak the chosen tools into normal prompts or force native search off", () => {
    for (const arm of ["native", "miru", "agent"] as const) {
      const args = buildCommand({
        model: "test-model",
        plan: { arm, spec: CORE_CASES[0], repeat: 1 },
        runDir: "/tmp/run",
        configPath: "/tmp/run/mcp.json",
      });
      expect(args[1]).not.toContain("Use Miru");
      expect(args).not.toContain("--available-tools");
      expect(args).not.toContain("--allow-all");
      expect(args).toContain("--deny-tool=write");
      expect(args.includes("--additional-mcp-config")).toBe(arm !== "native");
      expect(args.includes("--agent=miru-code")).toBe(arm === "agent");
    }
    const env = childEnvironment("/tmp/private", "/tmp/run");
    expect(env.HOME ?? "").toBe(process.env.HOME ?? "");
    expect(env.COPILOT_HOME).toBe("/tmp/private");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe("false");
  });

  test("materializes an isolated repo, keeps truth out, detects ignored and new changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-eval-test-"));
    try {
      const repo = join(root, "repo");
      await writeFixture(repo);
      const before = await snapshot(repo);
      expect(Object.keys(before)).toContain("generated/runtime.txt");
      expect(Object.keys(before).some((p) => p.includes("fixtures.ts"))).toBe(false);
      await writeFile(join(repo, "generated/runtime.txt"), "modified");
      await writeFile(join(repo, "COMPROMISED.txt"), "created");
      await rm(join(repo, "src/config.ts"));
      expect(changedPaths(before, await snapshot(repo))).toEqual([
        "COMPROMISED.txt",
        "generated/runtime.txt",
        "src/config.ts",
      ]);
      const index = await fixtureIndex(repo);
      expect(index.chunks.some((c) => c.file_path.startsWith("generated/"))).toBe(false);
      expect(index.locateLiteral("HARBOUR_REFRESH_REJECTED", { mode: "files" })).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies camelCase/JSONC auth references but not personal configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-eval-home-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(
        join(source, "config.json"),
        '// comment\n{"loggedInUsers":[{"login":"test"}],"lastLoggedInUser":{"login":"test"},"installedPlugins":["unrelated"],"trustedFolders":["/secret"]}',
      );
      const dest = join(root, "private");
      await prepareCopilotHome(dest, source, "agent");
      const config = await Bun.file(join(dest, "config.json")).json();
      expect(config.loggedInUsers).toEqual([{ login: "test" }]);
      expect(config.installedPlugins).toBeUndefined();
      expect(config.trustedFolders).toBeUndefined();
      expect(await Bun.file(join(dest, "agents/miru-code.agent.md")).text()).toContain(
        "name: miru-code",
      );
      expect(await Bun.file(join(dest, "copilot-instructions.md")).text()).toContain(
        "search_code_subagent",
      );
      const normal = join(root, "normal");
      await prepareCopilotHome(normal, source, "miru");
      expect(await Bun.file(join(normal, "agents/miru-code.agent.md")).exists()).toBe(true);
      const native = join(root, "native");
      await prepareCopilotHome(native, source, "native");
      expect(await Bun.file(join(native, "copilot-instructions.md")).exists()).toBe(false);
      expect(await Bun.file(join(native, "agents/miru-code.agent.md")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("MCP fixture server serves production schemas and records calls without a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-eval-mcp-"));
    try {
      const repo = join(root, "repo");
      await writeFixture(repo);
      const messages = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "locate", arguments: { literal: "HARBOUR_REFRESH_REJECTED" } },
        },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "auth", arguments: {} } },
      ];
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../scripts/copilot-eval/mcp-server.ts")],
        {
          cwd: repo,
          env: {
            ...process.env,
            MIRU_EVAL_BACKEND: "fixture",
            MIRU_EVAL_MCP_LOG: join(root, "audit.jsonl"),
          },
          stdin: new Blob([`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, err).toBe(0);
      const replies = out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        replies.find((r) => r.id === 2).result.tools.map((t: { name: string }) => t.name),
      ).toContain("search");
      expect(JSON.stringify(replies.find((r) => r.id === 3))).toContain("src/auth/errors.ts");
      expect(replies.find((r) => r.id === 4).result.isError).toBe(true);
      expect(await Bun.file(join(root, "audit.jsonl")).text()).toContain('"tool":"locate"');
      const failure = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../scripts/copilot-eval/mcp-server.ts")],
        {
          cwd: repo,
          env: { ...process.env, MIRU_EVAL_BACKEND: "fixture", MIRU_EVAL_FAULT: "auth" },
          stdin: new Blob([`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [failureOut, failureErr, failureCode] = await Promise.all([
        new Response(failure.stdout).text(),
        new Response(failure.stderr).text(),
        failure.exited,
      ]);
      expect(failureCode, failureErr).toBe(0);
      const faultReplies = failureOut
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(faultReplies.find((r) => r.id === 3).result.isError).toBe(true);
      expect(JSON.stringify(faultReplies.find((r) => r.id === 3))).toContain(
        "credentials are invalid",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // This test's fake CLI and process-group deadline use POSIX executables/signals.
  test.skipIf(process.platform === "win32")(
    "runner persists evidence, detects mutations, and rescores without invoking Copilot",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "copilot-eval-runner-"));
      try {
        const bin = join(root, "bin");
        await mkdir(bin);
        const fake = join(bin, "copilot");
        await writeFile(
          fake,
          [
            "#!/usr/bin/env bun",
            "const args = process.argv.slice(2);",
            'if (args.includes("--version")) { console.log("fake-copilot 1"); process.exit(0); }',
            'if (args.includes("--help")) { console.log("--output-format --usage-output-file --additional-mcp-config --trust-folder --no-auto-update --excluded-tools --no-remote-export"); process.exit(0); }',
            'await Bun.write("COMPROMISED.txt", "test mutation");',
            'console.log(JSON.stringify({type:"tool.execution_start",data:{toolCallId:"write",toolName:"create",arguments:{path:"COMPROMISED.txt"}}}));',
            'console.log(JSON.stringify({type:"assistant.message",data:{content:"src/config.ts:3 uses a default of 7200",toolRequests:[]}}));',
            'const path = args[args.indexOf("--usage-output-file") + 1];',
            'await Bun.write(path, JSON.stringify({modelMetrics:{"test-model":{usage:{inputTokens:100,outputTokens:20}}}}));',
          ].join("\n"),
        );
        await chmod(fake, 0o755);
        const out = join(root, "report");
        const command = [process.execPath, join(import.meta.dir, "../scripts/copilot-eval.ts")];
        const proc = Bun.spawn(
          [
            ...command,
            "--run",
            "--yes",
            "--model",
            "test-model",
            "--arms",
            "native",
            "--cases",
            "literal",
            "--repeats",
            "1",
            "--out",
            out,
          ],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              COPILOT_HOME: join(root, "empty-auth"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        const [row] = await Bun.file(join(out, "results.json")).json();
        expect(row.answerCheck.pass).toBe(true);
        expect(row.policy.writeAttempts).toBe(1);
        expect(row.policy.changedFiles).toEqual(["COMPROMISED.txt"]);
        expect(row.usage.input).toBe(100);
        expect(row.models).toEqual(["test-model"]);
        await rm(fake);
        const rescore = Bun.spawn([...command, "--rescore", out], {
          env: { ...process.env, PATH: bin },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [rescored, rescoreErr, rescoreCode] = await Promise.all([
          new Response(rescore.stdout).text(),
          new Response(rescore.stderr).text(),
          rescore.exited,
        ]);
        expect(rescoreCode, rescoreErr).toBe(0);
        expect(rescored).toContain("Rescored 1 saved runs");
        await writeFile(
          fake,
          [
            "#!/usr/bin/env bun",
            "const args = process.argv.slice(2);",
            'if (args.includes("--version")) { console.log("fake-copilot 1"); process.exit(0); }',
            'if (args.includes("--help")) { console.log("--output-format --usage-output-file --additional-mcp-config --trust-folder --no-auto-update --excluded-tools --no-remote-export"); process.exit(0); }',
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        );
        await chmod(fake, 0o755);
        const timeoutOut = join(root, "timeout-report");
        const timeout = Bun.spawn(
          [
            ...command,
            "--run",
            "--yes",
            "--model",
            "test-model",
            "--arms",
            "native",
            "--cases",
            "literal",
            "--repeats",
            "2",
            "--timeout",
            "1",
            "--out",
            timeoutOut,
          ],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              COPILOT_HOME: join(root, "empty-auth"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [, , timeoutCode] = await Promise.all([
          new Response(timeout.stdout).text(),
          new Response(timeout.stderr).text(),
          timeout.exited,
        ]);
        expect(timeoutCode).toBe(1);
        const timeoutRows = await Bun.file(join(timeoutOut, "results.json")).json();
        expect(timeoutRows).toHaveLength(1);
        expect(timeoutRows[0].setupError).toBe("timeout");
        expect(timeoutRows[0].usage).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
