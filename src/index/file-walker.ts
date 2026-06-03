import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".miru",
  ".next",
  "dist",
  "build",
  ".eggs",
]);

interface IgnoreSpec {
  base: string;
  spec: Ignore;
}

async function loadIgnoreForDir(directory: string): Promise<IgnoreSpec | null> {
  const paths = [join(directory, ".gitignore"), join(directory, ".miruignore")];
  const lines: string[] = [];

  for (const p of paths) {
    const file = Bun.file(p);
    if (await file.exists()) {
      lines.push(...(await file.text()).split("\n"));
    }
  }

  if (lines.length === 0) {
    return null;
  }
  return {
    base: directory,
    spec: ignore().add(lines),
  };
}

function isIgnoredBySpecs(fullPath: string, isDir: boolean, specs: IgnoreSpec[]): boolean {
  for (const spec of specs) {
    const relToSpec = relative(spec.base, fullPath).replace(/\\/g, "/");
    if (!relToSpec || relToSpec.startsWith("..")) {
      continue;
    }
    if (spec.spec.ignores(isDir ? `${relToSpec}/` : relToSpec)) {
      return true;
    }
  }
  return false;
}

export async function* walkFiles(root: string, extensions: string[]): AsyncGenerator<string> {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const loadedSpecs = new Map<string, IgnoreSpec | null>();

  async function* walk(dir: string, inheritedSpecs: IgnoreSpec[]): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    let spec = loadedSpecs.get(dir);
    if (spec === undefined) {
      spec = (await loadIgnoreForDir(dir)) ?? null;
      loadedSpecs.set(dir, spec);
    }
    const activeSpecs = spec ? [...inheritedSpecs, spec] : inheritedSpecs;

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (isIgnoredBySpecs(fullPath, true, activeSpecs)) {
          continue;
        }
        yield* walk(fullPath, activeSpecs);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isIgnoredBySpecs(fullPath, false, activeSpecs)) {
        continue;
      }

      const ext = entry.name.includes(".") ? `.${entry.name.split(".").pop()?.toLowerCase()}` : "";
      if (entry.name.toLowerCase() === "dockerfile" || extSet.has(ext)) {
        yield fullPath;
      }
    }
  }

  yield* walk(root, []);
}
