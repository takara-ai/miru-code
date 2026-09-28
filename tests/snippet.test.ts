import { describe, expect, test } from "bun:test";
import { anchorLineOffset, applySnippetsToResults, trimChunkToSnippet } from "../src/snippet.ts";
import type { Chunk } from "../src/types.ts";

function chunk(content: string, start = 1, language = "typescript"): Chunk {
  const lines = content.split("\n");
  return {
    content,
    file_path: "src/a.ts",
    start_line: start,
    end_line: start + lines.length - 1,
    language,
  };
}

describe("trimChunkToSnippet", () => {
  test("truncates around query-matching line", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines[20] = "async function hybridSearch() {}";
    const body = lines.join("\n");
    const { chunk: trimmed, meta } = trimChunkToSnippet(chunk(body), "hybrid search ranking", 5);

    expect(meta.truncated).toBe(true);
    expect(trimmed.content).toContain("hybridSearch");
    expect(trimmed.content.split("\n").length).toBeLessThanOrEqual(11);
    expect(meta.anchor_line).toBe(21);
    expect(meta.full_start_line).toBe(1);
    expect(meta.full_end_line).toBe(40);
  });

  test("leaves small chunks unchanged", () => {
    const small = chunk("export function main() {}\n");
    const { chunk: trimmed, meta } = trimChunkToSnippet(small, "main entry", 15);
    expect(meta.truncated).toBe(false);
    expect(trimmed.content).toBe(small.content);
  });

  test("anchorLineOffset prefers keyword lines", () => {
    const content = "import x\n\nfunction unrelated() {}\n\nfunction cliUi() {}\n";
    expect(anchorLineOffset(content, "cli-ui terminal")).toBe(4);
  });

  test("completes a nearby function instead of returning a broken body", () => {
    const source = [
      "export async function configureAgents() {",
      "  const agents = await discoverAgents();",
      "  if (agents.length === 0) {",
      "    return;",
      "  }",
      "  await installHooks(agents);",
      "}",
      "",
      "const unrelated = true;",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source), "install hooks", 1);
    expect(trimmed.content).toContain("export async function configureAgents");
    expect(trimmed.content).toContain("await installHooks(agents);");
    expect(trimmed.content.trimEnd().endsWith("}")).toBe(true);
  });

  test("completes an object literal instead of cutting its fields", () => {
    const source = [
      "const ANSI = {",
      '  reset: "\\x1b[0m",',
      '  bold: "\\x1b[1m",',
      '  dim: "\\x1b[2m",',
      "} as const;",
      "",
      "export function format() {}",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source), "bold ansi", 1);
    expect(trimmed.content).toContain("const ANSI = {");
    expect(trimmed.content).toContain("} as const;");
  });

  test("uses source context so a split function can be completed", () => {
    const first = chunk("export function configure() {\n  const agents = discover();", 10);
    const source = chunk(
      "export function configure() {\n  const agents = discover();\n  installHooks(agents);\n}",
      10,
    );
    const [{ result }] = applySnippetsToResults(
      [{ chunk: first, score: 1 }],
      "install hooks",
      2,
      new Map([[first.file_path, source]]),
    );
    const trimmed = result?.chunk ?? first;
    expect(trimmed.content).toContain("export function configure()");
    expect(trimmed.content).toContain("installHooks(agents);");
    expect(trimmed.content.trimEnd().endsWith("}")).toBe(true);
  });

  test("keeps the ranked-chunk anchor when source context has another query match", () => {
    const ranked = chunk("// target\nexport function wanted() {\n  return true;\n}", 20);
    const source = chunk(
      [
        "// target mentioned elsewhere",
        "const unrelated = true;",
        ...Array.from({ length: 17 }, () => ""),
        "// target",
        "export function wanted() {",
        "  return true;",
        "}",
      ].join("\n"),
      1,
    );
    const [{ meta }] = applySnippetsToResults(
      [{ chunk: ranked, score: 1 }],
      "target",
      1,
      new Map([[ranked.file_path, source]]),
    );
    expect(meta.anchor_line).toBe(20);
  });

  test("completes indentation-delimited Python functions", () => {
    const source = [
      "def configure_agents():",
      "    agents = discover_agents()",
      "    install_hooks(agents)",
      "    return agents",
      "",
      "def unrelated():",
      "    return None",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source, 1, "python"), "install hooks", 1);
    expect(trimmed.content).toContain("def configure_agents");
    expect(trimmed.content).toContain("return agents");
    expect(trimmed.content).not.toContain("def unrelated");
  });

  test("completes nested Ruby end blocks", () => {
    const source = [
      "def configure_agents(agents)",
      "  if agents.any?",
      "    install_hooks(agents)",
      "  end",
      "end",
      "",
      "def unrelated",
      "end",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source, 1, "ruby"), "install hooks", 1);
    expect(trimmed.content).toContain("install_hooks");
    expect(trimmed.content.trimEnd().endsWith("end")).toBe(true);
    expect(trimmed.content).not.toContain("def unrelated");
  });

  test("completes Elixir end blocks", () => {
    const source = [
      "defmodule Hooks do",
      "  def configure(agents) do",
      "    install_hooks(agents)",
      "  end",
      "end",
      "",
      "defmodule Unrelated do",
      "end",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source, 1, "elixir"), "install hooks", 1);
    expect(trimmed.content).toContain("install_hooks");
    expect(trimmed.content).not.toContain("Unrelated");
  });

  test("completes HTML elements", () => {
    const source = [
      '<section class="search">',
      "  <h1>Search</h1>",
      "  <button>Expand</button>",
      "</section>",
      "<footer>Footer</footer>",
    ].join("\n");
    const { chunk: trimmed } = trimChunkToSnippet(chunk(source, 1, "html"), "expand", 1);
    expect(trimmed.content).toContain('<section class="search">');
    expect(trimmed.content).toContain("</section>");
    expect(trimmed.content).not.toContain("<footer>");
  });

  test("completes C-style functions and shell functions", () => {
    const cSource = [
      "int configure_agents(int count) {",
      "  install_hooks(count);",
      "  return count;",
      "}",
      "int unrelated(void) { return 0; }",
    ].join("\n");
    const bashSource = [
      "configure_agents() {",
      '  install_hooks "$@"',
      "}",
      "unrelated() { :; }",
    ].join("\n");
    expect(trimChunkToSnippet(chunk(cSource, 1, "c"), "install hooks", 1).chunk.content).toContain(
      "return count;",
    );
    expect(
      trimChunkToSnippet(chunk(bashSource, 1, "bash"), "install hooks", 1).chunk.content,
    ).toContain('install_hooks "$@"');
  });

  test("completes CSS blocks and Haskell declarations", () => {
    const cssSource = [
      ".search-result {",
      "  display: grid;",
      "  gap: 1rem;",
      "}",
      ".footer { color: gray; }",
    ].join("\n");
    const haskellSource = [
      "configureAgents agents =",
      "  installHooks agents",
      "",
      "unrelated = Nothing",
    ].join("\n");
    const css = trimChunkToSnippet(chunk(cssSource, 1, "css"), "grid gap", 1).chunk.content;
    const haskell = trimChunkToSnippet(chunk(haskellSource, 1, "haskell"), "install hooks", 1).chunk
      .content;
    expect(css).toContain("gap: 1rem;");
    expect(css.trimEnd().endsWith("}")).toBe(true);
    expect(haskell).toContain("installHooks agents");
    expect(haskell).not.toContain("unrelated");
  });

  test("compacts long supporting hits into a complete outline", () => {
    const primary = chunk("export function primary() {\n  return true;\n}");
    const supporting = chunk(
      [
        "export function configureHooks() {",
        "  const first = true;",
        "  const second = true;",
        "  const third = true;",
        "  installHooks();",
        "  return first && second && third;",
        "}",
        ...Array.from({ length: 20 }, () => "// additional implementation"),
      ].join("\n"),
    );
    const output = applySnippetsToResults(
      [
        { chunk: primary, score: 1 },
        { chunk: supporting, score: 0.8 },
      ],
      "install hooks",
    );
    const compacted = output[1];
    expect(compacted?.result.chunk.content).toContain("[Supporting context — complete outline]");
    expect(compacted?.result.chunk.content).toContain("configureHooks");
    expect(compacted?.result.chunk.content).toContain("Matched line");
    expect(compacted?.meta.truncated).toBe(true);
  });

  test("keeps ordinary best hits complete but outlines unusually large ones", () => {
    const ordinary = chunk(["export function ordinary() {", "  return target;", "}"].join("\n"));
    const long = chunk(
      [
        "export function unusuallyLarge() {",
        "  const target = true;",
        ...Array.from({ length: 60 }, () => "  doWork();"),
        "}",
      ].join("\n"),
    );
    const output = applySnippetsToResults(
      [
        { chunk: ordinary, score: 1 },
        { chunk: long, score: 0.9 },
      ],
      "target",
    );
    expect(output[0]?.result.chunk.content).toContain("export function ordinary");
    expect(output[0]?.result.chunk.content).not.toContain("complete outline");
    expect(output[1]?.result.chunk.content).toContain("complete outline");

    const primaryLong = applySnippetsToResults([{ chunk: long, score: 1 }], "target");
    expect(primaryLong[0]?.result.chunk.content).toContain("complete outline");
    expect(primaryLong[0]?.result.chunk.content).toContain("Matched line");
  });

  test("applySnippetsToResults reduces token estimate", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `// filler ${i}`).join("\n");
    const big = chunk(`${lines}\nexport function target() {}\n${lines}`);
    const results = [{ chunk: big, score: 1 }];
    const fullTokens = Math.floor(big.content.length / 4);
    const snippetLen =
      applySnippetsToResults(results, "target function")[0]?.result.chunk.content.length ?? 0;
    const snippetTokens = Math.floor(snippetLen / 4);
    expect(snippetTokens).toBeLessThan(fullTokens / 2);
  });
});
