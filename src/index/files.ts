import { basename, extname } from "node:path";
import type { ContentType } from "../types.ts";

const MAX_FILE_BYTES = 1_000_000;
const EMPTY_FILE_BYTES = 128;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".sql": "sql",
  ".r": "r",
  ".R": "r",
  ".dart": "dart",
  ".zig": "zig",
  ".vue": "vue",
  ".svelte": "svelte",
  ".md": "markdown",
  ".mdx": "markdown",
  ".rst": "rst",
  ".txt": "text",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".dockerfile": "dockerfile",
};

const CODE_EXTENSIONS = new Set(
  Object.entries(EXTENSION_TO_LANGUAGE)
    .filter(
      ([, lang]) =>
        !["markdown", "rst", "text", "json", "yaml", "toml", "ini", "xml", "html"].includes(lang),
    )
    .map(([ext]) => ext),
);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".xml"]);

const CONTENT_EXTENSIONS: Record<ContentType, Set<string>> = {
  code: CODE_EXTENSIONS,
  docs: DOC_EXTENSIONS,
  config: CONFIG_EXTENSIONS,
};

export function getExtensions(types: ContentType[]): string[] {
  const exts = new Set<string>();
  for (const t of types) {
    for (const e of CONTENT_EXTENSIONS[t] ?? []) {
      exts.add(e);
    }
  }
  return [...exts].sort();
}

export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (basename(filePath).toLowerCase() === "dockerfile") {
    return "dockerfile";
  }
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export type FileStatus = "too_large" | "empty" | "valid";

export async function readFileText(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  return file.text();
}

export async function getFileStatus(filePath: string): Promise<FileStatus> {
  const file = Bun.file(filePath);
  const stat = await file.stat();
  if (stat.size > MAX_FILE_BYTES) {
    return "too_large";
  }
  if (stat.size < EMPTY_FILE_BYTES) {
    const text = await file.text();
    if (!text.trim()) {
      return "empty";
    }
  }
  return "valid";
}
