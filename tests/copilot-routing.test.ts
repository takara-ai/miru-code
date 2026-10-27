import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFixture } from "../scripts/copilot-eval/lib.ts";
import {
  contextDecision,
  type GuardState,
  indexedPaths,
  recordHits,
  searchesIndex,
} from "../src/copilot/routing-guard.ts";
import { AGENT_TARGETS } from "../src/installer/agents.ts";
import { applyCopilotRouting } from "../src/installer/copilot-routing.ts";

describe("Copilot routing guard", () => {
  test("all production locate line formats retain bounds, including grouped and inline hits", () => {
    const root = resolve("/repo");
    const state: GuardState = { hits: [], known: [] };
    recordHits(
      '"HARBOUR": 3 matches across 2 files\n\nsrc/auth/errors.ts:1: export const EXPIRED_REFRESH = "HARBOUR_REFRESH_REJECTED";\nsrc/config.ts\n  3: value\n  4: value',
      root,
      state,
    );
    recordHits(
      '"EXPIRED_REFRESH": 2 matches across 1 file\n\nsrc/auth/errors.ts\n  1: export const EXPIRED_REFRESH = "HARBOUR_REFRESH_REJECTED";\n  3: return new Error(EXPIRED_REFRESH);',
      root,
      state,
    );
    expect(state.hits).toEqual([
      { file: join(root, "src/auth/errors.ts"), start: 1, end: 1, read: false },
      { file: join(root, "src/config.ts"), start: 3, end: 4, read: false },
      { file: join(root, "src/auth/errors.ts"), start: 1, end: 3, read: false },
    ]);
    const indexed = new Set([join(root, "src/auth/errors.ts"), join(root, "Dockerfile")]);
    expect(
      contextDecision(
        "view",
        { path: "src/auth/errors.ts", view_range: [1, 30] },
        root,
        state,
        indexed,
      ).permissionDecision,
    ).toBe("deny");
    expect(
      contextDecision(
        "view",
        { path: "src/auth/errors.ts", view_range: [1, 3] },
        root,
        state,
        indexed,
      ),
    ).toEqual({});
    recordHits("Dockerfile", root, state);
    expect(
      contextDecision("view", { path: "Dockerfile", view_range: [1, 5] }, root, state, indexed),
    ).toEqual({});
  });
  test("native routing follows the index walker and preserves unindexed/external scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-guard-scope-"));
    try {
      const repo = join(root, "repo");
      await writeFixture(repo);
      await writeFile(join(repo, ".miruignore"), "private/\n");
      await mkdir(join(repo, "private"));
      await writeFile(join(repo, "private", "internal.ts"), "export const hidden = 1;\n");
      await writeFile(join(repo, "large.ts"), "x".repeat(1_000_001));
      const indexed = await indexedPaths(repo);
      expect(indexed.has(join(repo, "src/auth/session.ts"))).toBe(true);
      expect(indexed.has(join(repo, "large.ts"))).toBe(false);
      for (const name of ["rg", "grep", "glob", "grep_search", "file_search", "codebase_search"])
        expect(searchesIndex(name, {}, repo, indexed)).toBe(true);
      expect(searchesIndex("grep", { paths: "src" }, repo, indexed)).toBe(true);
      expect(searchesIndex("file_search", { query: "**/*.test.ts" }, repo, indexed)).toBe(true);
      for (const path of [
        "generated/runtime.txt",
        "generated",
        "private",
        "bun.lock",
        join(root, "external"),
      ])
        expect(searchesIndex("grep", { paths: path }, repo, indexed)).toBe(false);
      expect(searchesIndex("grep_search", { includePattern: "generated/**" }, repo, indexed)).toBe(
        false,
      );
      expect(searchesIndex("miru/locate", {}, repo, indexed)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context permissions require a located path and explicit reported ranges", () => {
    const root = resolve("/repo");
    const state: GuardState = { hits: [], known: [] };
    const indexed = new Set([join(root, "src/a.ts")]);
    recordHits("src/a.ts:40-58 [truncated: anchor_line 44]\n42: return 7;", root, state);
    const decide = (name: string, args: Record<string, unknown>) =>
      contextDecision(name, args, root, state, indexed).permissionDecision;
    expect(decide("miru/expand", { file_path: "src/a.ts", anchor_line: 44 })).toBe("deny");
    expect(decide("view", { path: "src/a.ts" })).toBe("deny");
    expect(decide("view", { path: "src/a.ts", view_range: [1, 200] })).toBe("deny");
    expect(decide("view", { path: "src/a.ts", view_range: [40, 58] })).toBeUndefined();
    expect(decide("view", { path: "generated/file.txt" })).toBeUndefined();
    expect(decide("view", { path: root })).toBe("deny");
    expect(decide("view", { path: join(root, "src") })).toBe("deny");
    expect(decide("view", { path: join(root, "generated") })).toBeUndefined();
    const hit = state.hits[0];
    if (!hit) throw new Error("Missing source hit");
    hit.read = true;
    expect(decide("miru/expand", { file_path: "src/a.ts", anchor_line: 44 })).toBeUndefined();
    expect(decide("miru/expand", { file_path: "src/a.ts", anchor_line: 999 })).toBe("deny");
    const locate: GuardState = { hits: [], known: [] };
    recordHits(
      '"symbol": 1 match\n\nsrc/a.ts:43\n  41: body\n  42: body\n  43: symbol\n  44: return 7;',
      root,
      locate,
    );
    expect(locate.hits[0]).toMatchObject({ start: 41, end: 44 });
    recordHits("../../escape.ts:1-10\n// evil.ts:1-99", root, locate);
    expect(locate.hits).toHaveLength(1);
  });

  test("installed standalone hooks redirect native tools, isolate child state, and uninstall cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-guard-live-"));
    try {
      const repo = join(root, "repo");
      await writeFixture(repo);
      const home = join(root, "home");
      await mkdir(home);
      const original = AGENT_TARGETS.find((a) => a.id === "copilot");
      if (!original?.mcp) throw new Error("Missing Copilot target");
      const config = join(home, "mcp-config.json");
      await writeFile(
        config,
        `// Copilot user configuration\n${JSON.stringify({ mcpServers: { miru: { command: "test" } } })}`,
      );
      const target = {
        ...original,
        instructionsPath: join(home, "copilot-instructions.md"),
        mcp: { ...original.mcp, path: config },
      };
      await applyCopilotRouting(target, "install");
      await writeFile(join(home, "hooks", "user.json"), "{}");
      const hooks = (await Bun.file(join(home, "hooks", "miru-routing.json")).json()).hooks;
      const call = async (event: string, data: object) => {
        const hook = hooks[event][0];
        const proc = Bun.spawn([hook.exec, ...hook.args], {
          stdin: new Blob([JSON.stringify({ cwd: repo, sessionId: "session", ...data })]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, err).toBe(0);
        return JSON.parse(out);
      };
      expect(
        (await call("preToolUse", { toolName: "grep", toolArgs: JSON.stringify({ paths: "." }) }))
          .permissionDecision,
      ).toBe("deny");
      expect(
        (await call("preToolUse", { toolName: "view", toolArgs: { path: repo } }))
          .permissionDecision,
      ).toBe("deny");
      expect(
        await call("preToolUse", {
          toolName: "grep",
          toolArgs: { paths: "generated/runtime.txt" },
        }),
      ).toEqual({});
      expect(
        (
          await call("preToolUse", {
            toolName: "search_code_subagent",
            toolArgs: { query: "session" },
          })
        ).permissionDecision,
      ).toBe("deny");
      const post = await call("postToolUse", {
        toolName: "miru/locate",
        toolArgs: {},
        toolResult: {
          resultType: "success",
          textResultForLlm:
            "src/auth/session.ts:1-8 [truncated: anchor_line 4]\n4: function ensureFreshSession",
        },
      });
      expect(post.additionalContext).toContain("Units require source evidence");
      expect(post.additionalContext.length).toBeLessThan(300);
      expect(
        await call("postToolUse", {
          toolName: "miru/locate",
          toolArgs: { mode: "files" },
          toolResult: { resultType: "success", textResultForLlm: "src/auth/session.ts" },
        }),
      ).toEqual({});
      const expand = {
        toolName: "miru/expand",
        toolArgs: { file_path: "src/auth/session.ts", anchor_line: 4 },
      };
      expect((await call("preToolUse", expand)).permissionDecision).toBe("deny");
      const view = {
        toolName: "view",
        toolArgs: { path: join(repo, "src/auth/session.ts"), view_range: [1, 8] },
      };
      expect(await call("preToolUse", view)).toEqual({});
      await call("postToolUse", {
        ...view,
        toolResult: { resultType: "failure", textResultForLlm: "Read failed" },
      });
      expect((await call("preToolUse", expand)).permissionDecision).toBe("deny");
      await call("postToolUse", {
        ...view,
        toolResult: { resultType: "success", textResultForLlm: "source" },
      });
      expect(await call("preToolUse", expand)).toEqual({});
      expect((await call("preToolUse", { ...expand, agentId: "child" })).permissionDecision).toBe(
        "deny",
      );
      expect(
        (
          await call("preToolUse", {
            toolName: "miru/locate",
            toolArgs: { literal: "test", repo: join(root, "nonexistent-repo") },
          })
        ).permissionDecision,
      ).toBe("deny");
      await call("postToolUse", {
        sessionId: "grouped-session",
        toolName: "miru/locate",
        toolArgs: {},
        toolResult: {
          resultType: "success",
          textResultForLlm:
            "src/auth/errors.ts\n  1: EXPIRED_REFRESH\n  3: return new Error(EXPIRED_REFRESH);",
        },
      });
      expect(
        (
          await call("preToolUse", {
            sessionId: "grouped-session",
            toolName: "view",
            toolArgs: { path: join(repo, "src/auth/errors.ts"), view_range: [1, 30] },
          })
        ).permissionDecision,
      ).toBe("deny");
      expect(
        await call("preToolUse", {
          sessionId: "grouped-session",
          toolName: "view",
          toolArgs: { path: join(repo, "src/auth/errors.ts"), view_range: [1, 3] },
        }),
      ).toEqual({});
      expect(
        (await Bun.file(join(home, "miru-routing", "audit.jsonl")).text()).includes(
          '"event":"error"',
        ),
      ).toBe(false);
      // Concurrent successful reads must not overwrite one another's context state.
      await call("postToolUse", {
        toolName: "miru/search",
        toolArgs: {},
        toolResult: {
          resultType: "success",
          textResultForLlm: "src/routes/orders.ts:1-5\n1: import session",
        },
      });
      const orders = {
        toolName: "view",
        toolArgs: { path: join(repo, "src/routes/orders.ts"), view_range: [1, 5] },
      };
      await Promise.all([
        call("postToolUse", {
          ...view,
          toolResult: { resultType: "success", textResultForLlm: "source" },
        }),
        call("postToolUse", {
          ...orders,
          toolResult: { resultType: "success", textResultForLlm: "source" },
        }),
      ]);
      expect(await call("preToolUse", expand)).toEqual({});
      expect(
        await call("preToolUse", {
          toolName: "miru/expand",
          toolArgs: { file_path: "src/routes/orders.ts", anchor_line: 3 },
        }),
      ).toEqual({});
      await applyCopilotRouting(target, "uninstall");
      expect(await Bun.file(join(home, "hooks", "miru-routing.json")).exists()).toBe(false);
      expect(await Bun.file(join(home, "hooks", "user.json")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
