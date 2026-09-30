import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import {
  ensureParserInit,
  getLanguageForFile,
  grammarManifest,
  grammarsDir,
  hasVendoredGrammar,
  wasmPathForFile,
  wasmPathForLanguage,
  webTreeSitterRuntimePath,
} from "../src/chunking/grammars.ts";

describe("vendored tree-sitter grammars", () => {
  test("manifest lists wasm files that exist on disk", () => {
    expect(grammarManifest.files.length).toBeGreaterThan(0);
    for (const file of grammarManifest.files) {
      expect(existsSync(join(grammarsDir(), file))).toBe(true);
    }
  });

  test("core Miru languages are mapped", () => {
    for (const lang of ["python", "typescript", "javascript", "go", "rust", "cpp", "c"]) {
      expect(wasmPathForLanguage(lang)).not.toBeNull();
    }
    expect(wasmPathForLanguage(null)).toBeNull();
    expect(wasmPathForLanguage("not-a-language")).toBeNull();
    expect(wasmPathForFile("component.tsx", "typescript")).toContain("tree-sitter-tsx.wasm");
    expect(wasmPathForFile("component.tsx", "typescript", () => false)).toBe(
      wasmPathForLanguage("typescript"),
    );
    expect(wasmPathForFile("component.ts", "typescript")).toBe(wasmPathForLanguage("typescript"));
    expect(wasmPathForFile("component.tsx", null)).toBeNull();
    expect(hasVendoredGrammar("not-a-language")).toBe(false);
    expect(hasVendoredGrammar(null)).toBe(false);
  });

  test("SQL and component-based web grammars parse real samples", async () => {
    await ensureParserInit();
    const samples: Array<[string, string, string]> = [
      ["sql", "schema.sql", "CREATE TABLE users (id INT PRIMARY KEY);\nSELECT id FROM users;\n"],
      [
        "astro",
        "Page.astro",
        "---\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n<style>h1 { color: red; }</style>\n",
      ],
      [
        "vue",
        "App.vue",
        '<template><div>{{ msg }}</div></template>\n<script setup lang="ts">const msg = "hi";</script>\n',
      ],
      [
        "svelte",
        "App.svelte",
        "<script>let count = 0;</script>\n<button on:click={() => count++}>{count}</button>\n",
      ],
    ];
    for (const [language, file, source] of samples) {
      expect(hasVendoredGrammar(language)).toBe(true);
      const grammar = await getLanguageForFile(file, language);
      expect(grammar).not.toBeNull();
      if (grammar === null) {
        throw new Error(`expected ${language} grammar`);
      }
      const parser = new Parser();
      parser.setLanguage(grammar);
      const tree = parser.parse(source);
      expect(tree?.rootNode.childCount).toBeGreaterThan(0);
      expect(tree?.rootNode.hasError).toBe(false);
    }
  });

  test("web-tree-sitter loads runtime and a vendored grammar", async () => {
    await Parser.init({ locateFile: () => webTreeSitterRuntimePath() });
    const pythonWasm = wasmPathForLanguage("python");
    expect(pythonWasm).not.toBeNull();
    if (pythonWasm === null) {
      throw new Error("expected python grammar wasm");
    }
    const language = await Language.load(pythonWasm);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse("def hello():\n    return 1\n");
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe("module");
    await ensureParserInit();
    expect(await getLanguageForFile("example.py", "python")).not.toBeNull();
    expect(await getLanguageForFile("example.unknown", "not-a-language")).toBeNull();
    expect(
      await getLanguageForFile("example.py", "python", async () => {
        throw new Error("bad wasm");
      }),
    ).toBeNull();
  });
});
