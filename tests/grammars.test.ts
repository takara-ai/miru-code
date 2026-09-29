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
