import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type GrammarManifest = {
  version: number;
  runtime: string;
  languages: Record<string, string>;
  files: string[];
};

export const grammarManifest: GrammarManifest = JSON.parse(
  readFileSync(join(packageRoot, "grammars/manifest.json"), "utf8"),
) as GrammarManifest;

/** Absolute path to the vendored grammars directory. */
export function grammarsDir(): string {
  return join(packageRoot, "grammars");
}

/** Resolve vendored wasm path for a Miru language id, if we ship a grammar for it. */
export function wasmPathForLanguage(language: string | null): string | null {
  if (!language) {
    return null;
  }
  const file = grammarManifest.languages[language];
  if (!file) {
    return null;
  }
  return join(grammarsDir(), file);
}

/** Pick grammar wasm for a file (e.g. tsx vs typescript). */
export function wasmPathForFile(filePath: string, language: string | null): string | null {
  if (!language) {
    return null;
  }
  if (language === "typescript" && filePath.toLowerCase().endsWith(".tsx")) {
    const tsxPath = join(grammarsDir(), "tree-sitter-tsx.wasm");
    if (existsSync(tsxPath)) {
      return tsxPath;
    }
  }
  return wasmPathForLanguage(language);
}

/** Absolute path to web-tree-sitter's runtime wasm (0.26.x). */
export function webTreeSitterRuntimePath(): string {
  const pkgDir = dirname(require.resolve("web-tree-sitter/package.json"));
  return join(pkgDir, "web-tree-sitter.wasm");
}

export function hasVendoredGrammar(language: string | null): boolean {
  return wasmPathForLanguage(language) !== null;
}

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();

/** Initialize web-tree-sitter once per process (safe to call repeatedly). */
export async function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({ locateFile: () => webTreeSitterRuntimePath() });
  }
  await parserInitPromise;
}

async function loadLanguage(wasmPath: string): Promise<Language> {
  let pending = languageCache.get(wasmPath);
  if (!pending) {
    pending = (async () => {
      await ensureParserInit();
      return Language.load(wasmPath);
    })();
    languageCache.set(wasmPath, pending);
  }
  return pending;
}

/** Load a cached Language for the given file, or null if unsupported / missing. */
export async function getLanguageForFile(
  filePath: string,
  language: string | null,
): Promise<Language | null> {
  const wasmPath = wasmPathForFile(filePath, language);
  if (!wasmPath || !existsSync(wasmPath)) {
    return null;
  }
  try {
    return await loadLanguage(wasmPath);
  } catch {
    return null;
  }
}
