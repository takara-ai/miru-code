import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import {
  grammarManifest,
  grammarsDir,
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
  });
});
