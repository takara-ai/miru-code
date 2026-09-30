import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacySearchHooks } from "../src/installer/legacy-hooks.ts";

describe("legacy search-hook cleanup", () => {
  test("removes only Miru entries and preserves other hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-old-hooks-"));
    try {
      const cases = [
        ["claude", "PreToolUse", { hooks: [{ command: "miru hook-guard" }] }],
        ["cursor", "preToolUse", { command: "miru hook-guard" }],
        ["gemini", "BeforeTool", { command: "miru hook-guard" }],
        ["kiro", "preToolUse", { command: "miru hook-guard" }],
        ["windsurf", "pre_run_command", { command: "miru hook-guard" }],
        ["vscode", "PreToolUse", { command: "miru hook-guard" }],
      ] as const;

      for (const [format, event, miruEntry] of cases) {
        const path = join(root, `${format}.json`);
        await Bun.write(
          path,
          JSON.stringify({
            version: 1,
            hooks: { [event]: [miruEntry, { command: "user hook" }] },
          }),
        );
        expect(await removeLegacySearchHooks(format, path)).toBe("removed");
        const config = JSON.parse(await Bun.file(path).text());
        expect(config.hooks[event]).toEqual([{ command: "user hook" }]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps shared Copilot hook until the final owning IDE is uninstalled", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-old-copilot-hooks-"));
    try {
      const path = join(root, "hooks.json");
      await Bun.write(
        path,
        JSON.stringify({
          miruOwners: ["copilot", "vscode"],
          hooks: { PreToolUse: [{ command: "miru hook-guard" }] },
        }),
      );
      expect(await removeLegacySearchHooks("vscode", path, "copilot")).toBe("updated");
      expect(JSON.parse(await Bun.file(path).text()).hooks.PreToolUse).toHaveLength(1);
      expect(await removeLegacySearchHooks("vscode", path, "vscode")).toBe("removed");
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes the last shared owner even when no Miru hook remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-old-copilot-owner-"));
    try {
      const configs = [
        { miruOwners: ["vscode"], setting: true },
        { miruOwners: ["vscode"], hooks: { PostToolUse: [{ command: "user hook" }] } },
        { miruOwners: ["vscode"], hooks: { PreToolUse: [{ command: "user hook" }] } },
      ];
      for (const [index, config] of configs.entries()) {
        const path = join(root, `${index}.json`);
        await Bun.write(path, JSON.stringify(config));
        expect(await removeLegacySearchHooks("vscode", path, "vscode")).toBe("removed");
        const remaining = JSON.parse(await Bun.file(path).text());
        expect(remaining.miruOwners).toBeUndefined();
        expect(remaining.hooks).toEqual(config.hooks);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves unrelated hooks alone when no legacy Miru command matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-unrelated-hooks-"));
    try {
      const path = join(root, "settings.json");
      const config = { hooks: { PreToolUse: [null, [], { hooks: [{ command: "user hook" }] }] } };
      await Bun.write(path, JSON.stringify(config));
      expect(await removeLegacySearchHooks("claude", path)).toBe("not-found");
      expect(JSON.parse(await Bun.file(path).text())).toEqual(config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes OpenCode's Miru-specific plugin and ignores missing or malformed configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-old-opencode-hooks-"));
    try {
      const plugin = join(root, "miru-search-guard.ts");
      await Bun.write(plugin, "export default {};\n");
      expect(await removeLegacySearchHooks("opencode", plugin)).toBe("removed");
      expect(await removeLegacySearchHooks("opencode", plugin)).toBe("not-found");

      const malformed = join(root, "settings.json");
      await Bun.write(malformed, "{");
      expect(await removeLegacySearchHooks("claude", malformed)).toBe("error");
      expect(await removeLegacySearchHooks("claude", join(root, "missing.json"))).toBe("not-found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
