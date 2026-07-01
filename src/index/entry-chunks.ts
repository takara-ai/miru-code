import { join, relative } from "node:path";
import type { Chunk } from "../types.ts";

function indexedPath(absPath: string, _repoRoot: string, displayRoot?: string): string {
  if (displayRoot) {
    return relative(displayRoot, absPath).replace(/\\/g, "/");
  }
  return absPath.replace(/\\/g, "/");
}

async function packageJsonEntryChunks(
  absPath: string,
  repoRoot: string,
  displayRoot?: string,
): Promise<Chunk[]> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await Bun.file(absPath).text()) as Record<string, unknown>;
  } catch {
    return [];
  }

  const entryLines = ["[package entry]"];

  const bin = pkg.bin;
  if (typeof bin === "string") {
    entryLines.push(`bin: ${bin}`);
  } else if (bin && typeof bin === "object") {
    for (const [name, target] of Object.entries(bin)) {
      entryLines.push(`bin ${name}: ${String(target)}`);
    }
  }

  if (typeof pkg.main === "string") {
    entryLines.push(`main: ${pkg.main}`);
  }

  const types = pkg.types ?? pkg.typings;
  if (typeof types === "string") {
    entryLines.push(`types: ${types}`);
  }

  if (entryLines.length <= 1) {
    return [];
  }

  const filePath = indexedPath(absPath, repoRoot, displayRoot);
  const content = `${entryLines.join("\n")}\n`;

  return [
    {
      content,
      file_path: filePath,
      start_line: 1,
      end_line: entryLines.length,
      language: "json",
    },
  ];
}

/** Synthetic chunks for root config entry points (bin/main) when indexing code repos. */
export async function loadRootEntryChunks(
  repoRoot: string,
  displayRoot?: string,
): Promise<Chunk[]> {
  const pkgPath = join(repoRoot, "package.json");
  if (!(await Bun.file(pkgPath).exists())) {
    return [];
  }
  return packageJsonEntryChunks(pkgPath, repoRoot, displayRoot);
}
