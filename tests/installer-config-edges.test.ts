import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSkillsFeatureEnabled,
  ensureCodexSkillsFeature,
  jsoncTestUtils,
  mergeJsonMember,
  mergeTomlBlock,
  removeJsonMember,
  removeMarked,
  removeTomlBlock,
  replaceOrAppendMarked,
  stripJsonComments,
} from "../src/installer/config.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "miru-installer-config-"));
  return root;
}

describe("installer config edge cases", () => {
  test("covers JSONC scanner edge cases directly", () => {
    const scanner = jsoncTestUtils;
    expect(scanner.hasJsoncSyntax('{"url":"https://host/path"}')).toBe(false);
    expect(scanner.hasJsoncSyntax('{"text":"escaped \\" // text"}')).toBe(false);
    expect(scanner.hasJsoncSyntax('{"x":1 // comment\n}')).toBe(true);
    expect(scanner.hasJsoncSyntax('{"x":1 /* comment */}')).toBe(true);

    expect(scanner.findSectionRange('{"keep":true}', "missing")).toBeNull();
    expect(scanner.findSectionRange('{"mcpServers": {', "mcpServers")).toBeNull();
    expect(scanner.findSectionRange('{"mcpServers": {"x": "}"}}', "mcpServers")).toEqual({
      openBrace: 15,
      closeBrace: 24,
      indent: "",
    });
    expect(
      scanner.findSectionRange(
        '{"noise":"escaped \\" brace {", // comment\n"mcpServers": {}}',
        "mcpServers",
      ),
    ).not.toBeNull();

    expect(scanner.findMatchingBrace('{"x":"}\\"{", /* } */ "nested":{}}', 0)).toBe(32);
    expect(scanner.findMatchingBrace('{"x":1 // }\n}', 0)).toBe(12);
    expect(scanner.findMatchingBrace('{"x": {', 5)).toBe(-1);
    expect(scanner.parseJsonValueEnd('{"x":1}', 5)).toBe(6);
    expect(scanner.parseJsonValueEnd('{"x":[1,2]}', 5)).toBe(10);
    expect(scanner.parseJsonValueEnd('{"x":"v\\"x"}', 5)).toBe(11);
    expect(scanner.parseJsonValueEnd('{"x":', 5)).toBe(5);
    expect(scanner.findMatchingBracket('["\\"]", [1]]', 0)).toBe(11);
    expect(scanner.findMatchingBracket("[1", 0)).toBe(-1);
    expect(scanner.findStringEnd('"a\\"b"', 0)).toBe(5);
    expect(scanner.findStringEnd('"unfinished', 0)).toBe(0);
    expect(scanner.skipWhitespace("  x", 0)).toBe(2);
    expect(scanner.findLeadingComma("a,  b", 4, 0)).toBe(1);
    expect(scanner.findLeadingComma("a  b", 4, 0)).toBe(-1);

    expect(scanner.withRemovedMember({ section: [] }, "section", "member")).toEqual({
      section: [],
    });
    expect(scanner.upsertJsonMemberText('{"section":{}}', "section", "member", {})).toBeNull();
    expect(scanner.upsertJsonMemberText("{ /* comment */ }", "section", "member", {})).toBeNull();
    expect(
      scanner.upsertJsonMemberText(
        '{ /* comment */ "section": { "member": } }',
        "section",
        "member",
        {},
      ),
    ).toBeNull();
    expect(scanner.removeJsonMemberText('{"section":{}}', "section", "member")).toBeNull();
    expect(scanner.removeJsonMemberText("{ /* comment */ }", "section", "member")).toBeNull();
    expect(
      scanner.removeJsonMemberText(
        '{ /* comment */ "section": { "member": 1 } }',
        "section",
        "missing",
      ),
    ).toBeNull();
    expect(
      scanner.removeJsonMemberText(
        '{ /* comment */ "section": { "keep": 1, "member": 2 } }',
        "section",
        "member",
      ),
    ).toContain('"keep": 1');
  });

  test("strips block comments while preserving comment markers in strings", () => {
    const text =
      '{"url":"https://example.test/a/*literal*/", /* comment */ "text":"\\"// still text"}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: "https://example.test/a/*literal*/",
      text: '"// still text',
    });
    expect(stripJsonComments('{"x":1, /* unclosed')).toContain('"x":1, ');
  });

  test("merges and removes JSON entries across malformed and empty configs", async () => {
    const dir = await tempRoot();
    const path = join(dir, "settings.json");
    const value = { command: "bunx", args: ["miru"] };

    expect(await mergeJsonMember(path, "mcpServers", "miru", value)).toBe("created");
    expect(await mergeJsonMember(path, "mcpServers", "miru", value)).toBe("unchanged");
    expect(await removeJsonMember(join(dir, "absent.json"), "mcpServers", "miru")).toBe(
      "not-found",
    );
    expect(await removeJsonMember(path, "mcpServers", "other")).toBe("not-found");
    expect(await removeJsonMember(path, "missingSection", "miru")).toBe("not-found");
    expect(await removeJsonMember(path, "mcpServers", "miru")).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);

    const malformed = join(dir, "malformed.json");
    await Bun.write(malformed, "not-json");
    expect(await mergeJsonMember(malformed, "mcpServers", "miru", value)).toBe("error");
    expect(await removeJsonMember(malformed, "mcpServers", "miru")).toBe("error");
    await Bun.write(malformed, '{"mcpServers": []}');
    expect(await mergeJsonMember(malformed, "mcpServers", "miru", value)).toBe("error");
    expect(await removeJsonMember(malformed, "mcpServers", "miru")).toBe("not-found");
    await Bun.write(malformed, "[]");
    expect(await mergeJsonMember(malformed, "mcpServers", "miru", value)).toBe("error");
  });

  test("removes one JSON member while retaining other root and section members", async () => {
    const dir = await tempRoot();
    const path = join(dir, "settings.json");
    await Bun.write(
      path,
      JSON.stringify(
        {
          keep: true,
          mcpServers: { miru: { args: ["miru"] }, other: { args: ["other"] } },
        },
        null,
        2,
      ),
    );
    expect(await removeJsonMember(path, "mcpServers", "miru")).toBe("removed");
    expect(JSON.parse(await Bun.file(path).text())).toEqual({
      keep: true,
      mcpServers: { other: { args: ["other"] } },
    });
  });

  test("updates nested JSONC values and removes the last member safely", async () => {
    const dir = await tempRoot();
    const path = join(dir, "settings.jsonc");
    await Bun.write(
      path,
      '{\n  /* retain */\n  "mcpServers": {\n    "miru": { "old": true },\n    "other": { "items": [{ "brace": "}" }] }\n  }\n}\n',
    );
    const value = {
      nested: [{ text: 'escaped \\" } // literal', values: [1, 2] }],
      url: "https://host/path",
    };
    expect(await mergeJsonMember(path, "mcpServers", "miru", value)).toBe("updated");
    const mergedText = await Bun.file(path).text();
    expect(mergedText).toContain("/* retain */");
    expect(JSON.parse(stripJsonComments(mergedText)).mcpServers.miru).toEqual(value);
    expect(await removeJsonMember(path, "mcpServers", "miru")).toBe("removed");
    expect(JSON.parse(stripJsonComments(await Bun.file(path).text())).mcpServers).toEqual({
      other: { items: [{ brace: "}" }] },
    });
  });

  test("inserts into an existing JSONC section that has no Miru member", async () => {
    const dir = await tempRoot();
    const path = join(dir, "insert.jsonc");
    await Bun.write(path, '{\n  // retain comment\n  "mcpServers": {}\n}\n');
    expect(await mergeJsonMember(path, "mcpServers", "miru", { command: "bunx" })).toBe("updated");
    const text = await Bun.file(path).text();
    expect(text).toContain("// retain comment");
    expect(JSON.parse(stripJsonComments(text)).mcpServers.miru).toEqual({ command: "bunx" });
  });

  test("removes escaped string and array values from JSONC while preserving neighbors", async () => {
    const dir = await tempRoot();
    const path = join(dir, "remove-values.jsonc");
    await Bun.write(
      path,
      '{\n  "mcpServers": {\n    "keep": [1, 2], /* keep this */\n    "miru": "quoted \\"value\\""\n  },\n  "enabled": true\n}\n',
    );
    expect(await removeJsonMember(path, "mcpServers", "miru")).toBe("removed");
    expect(JSON.parse(stripJsonComments(await Bun.file(path).text()))).toEqual({
      mcpServers: { keep: [1, 2] },
      enabled: true,
    });

    const scalar = join(dir, "remove-scalar.jsonc");
    await Bun.write(scalar, '{\n  "mcpServers": {\n    "miru": true,\n    "keep": 1\n  }\n}\n');
    expect(await removeJsonMember(scalar, "mcpServers", "miru")).toBe("removed");
    expect(JSON.parse(stripJsonComments(await Bun.file(scalar).text())).mcpServers.keep).toBe(1);
  });

  test("preserves JSONC while editing escaped member names and array or string values", async () => {
    const dir = await tempRoot();
    const path = join(dir, "escaped.jsonc");
    await Bun.write(
      path,
      '{\n  // keep comment\n  "mcpServers": {\n    "miru.server": [{ "text": "escaped \\" brace }" }]\n  },\n  "keep": true\n}\n',
    );
    expect(await mergeJsonMember(path, "mcpServers", "miru.server", { ok: true })).toBe("updated");
    expect(
      JSON.parse(stripJsonComments(await Bun.file(path).text())).mcpServers["miru.server"],
    ).toEqual({ ok: true });
    await Bun.write(
      path,
      '{\n  // keep comment\n  "mcpServers": {\n    "miru.server": "plain value"\n  },\n  "keep": true\n}\n',
    );
    expect(await removeJsonMember(path, "mcpServers", "miru.server")).toBe("removed");
    expect(JSON.parse(stripJsonComments(await Bun.file(path).text()))).toEqual({
      mcpServers: {},
      keep: true,
    });
  });

  test("appends marked content and removes only valid marked blocks", async () => {
    const dir = await tempRoot();
    const path = join(dir, "instructions.md");
    const marked = "<!-- miru:start -->\nmanaged\n<!-- miru:end -->";
    expect(await replaceOrAppendMarked(path, marked)).toBe("created");
    expect(await replaceOrAppendMarked(path, marked)).toBe("updated");
    expect(await replaceOrAppendMarked(path, marked)).toBe("unchanged");
    expect(
      await replaceOrAppendMarked(path, "<!-- miru:start -->\nupdated block\n<!-- miru:end -->"),
    ).toBe("updated");
    expect(await Bun.file(path).text()).toContain("updated block");
    expect(await removeMarked(path)).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await removeMarked(path)).toBe("not-found");

    await Bun.write(path, "user text without markers");
    expect(await removeMarked(path)).toBe("not-found");
    await Bun.write(path, "<!-- miru:end -->\n<!-- miru:start -->");
    expect(await removeMarked(path)).toBe("not-found");
    expect(await replaceOrAppendMarked(path, "new section")).toBe("updated");
    await Bun.write(path, `user text\n${marked}\nmore user text\n`);
    expect(await removeMarked(path)).toBe("removed");
    expect(await Bun.file(path).text()).toBe("user text\nmore user text\n\n");
  });

  test("merges and removes Codex TOML while retaining unrelated sections", async () => {
    const dir = await tempRoot();
    const path = join(dir, "config.toml");
    expect(await mergeTomlBlock(path)).toBe("created");
    expect(await mergeTomlBlock(path)).toBe("unchanged");
    await Bun.write(
      path,
      '[other]\nkeep = true\n\n[mcp_servers.miru]\ncommand = "old"\n\n[mcp_servers.miru.extra]\nvalue = 1\n',
    );
    expect(await mergeTomlBlock(path)).toBe("updated");
    const merged = await Bun.file(path).text();
    expect(merged).toContain("[other]");
    expect(merged).not.toContain("mcp_servers.miru.extra");
    expect(await removeTomlBlock(path)).toBe("removed");
    expect(await Bun.file(path).text()).toContain("keep = true");
    expect(await removeTomlBlock(path)).toBe("not-found");
    expect(await removeTomlBlock(join(dir, "missing.toml"))).toBe("not-found");
  });

  test("preserves benchmark mode and removes a TOML file when the MCP block is its only content", async () => {
    const dir = await tempRoot();
    const path = join(dir, "config.toml");
    await Bun.write(path, '[mcp_servers.miru]\ncommand = "old"\nargs = ["--benchmark"]\n');
    expect(await mergeTomlBlock(path)).toBe("updated");
    expect(await Bun.file(path).text()).toContain('"--benchmark"');
    expect(await removeTomlBlock(path)).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("detects and updates Codex skills flags", async () => {
    const dir = await tempRoot();
    const path = join(dir, "config.toml");
    expect(codexSkillsFeatureEnabled("[other]\nskills = true\n")).toBe(false);
    expect(codexSkillsFeatureEnabled("[features]\nskills = false # disabled\n")).toBe(false);
    expect(codexSkillsFeatureEnabled("[features]\nskills = TRUE # enabled\n")).toBe(true);
    expect(await ensureCodexSkillsFeature(path)).toBe("created");
    expect(await ensureCodexSkillsFeature(path)).toBe("unchanged");
    await Bun.write(path, "[features]\nskills = false\n");
    expect(await ensureCodexSkillsFeature(path)).toBe("updated");
    expect(await Bun.file(path).text()).toContain("skills = true");

    await Bun.write(path, "[features]\n# next section\n[other]\nvalue = true\n");
    expect(await ensureCodexSkillsFeature(path)).toBe("updated");
    expect(await Bun.file(path).text()).toContain("[features]\nskills = true");
  });
});
