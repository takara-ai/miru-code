import { basename } from "node:path";
import type { Chunk } from "../types.ts";
import { chunkKey } from "../types.ts";

const LOCATION_QUERY_RE =
  /\b(where(?:'s| is)?|entry\s*point|bootstrap|starts?|live[s]?|located|defined|wiring)\b/i;

const ENTRY_POINT_QUERY_RE = /\b(entry\s*point|bootstrap|starts?|wiring|command\s*line)\b/i;

const INTEGRATION_QUERY_RE = /\b(install|uninstall|hook|agent|configure|setup)\b/i;

const INSTALLER_PATH_RE = /(?:^|\/)installer(?:\/|$)/;

const ENTRY_POINT_CONTENT_RE =
  /#!\/usr\/bin|(?:^|\n)\s*(?:async\s+)?function\s+main\s*\(|(?:^|\n)\s*if\s*\(\s*require\.main\s*===\s*module/;

const PACKAGE_ENTRY_RE = /^\[package entry\]/;

const LOCATION_BOOST_MULTIPLIER = 2.5;
const INSTALLER_LOCATION_PENALTY = 0.35;

/** Too common as filenames to get exact-stem boosts from incidental query tokens. */
const IMPLEMENTATION_HINTS = new Set(
  [
    "command",
    "handler",
    "router",
    "routing",
    "middleware",
    "model",
    "channel",
    "request",
    "response",
    "dispatch",
    "pipeline",
  ].map((w) => w.toLowerCase()),
);

const GENERIC_STEM_DENY = new Set(
  [
    "route",
    "routes",
    "router",
    "routing",
    "handler",
    "middleware",
    "channel",
    "model",
    "models",
    "request",
    "response",
    "utils",
    "util",
    "server",
    "client",
    "application",
    "dispatch",
    "core",
    "lib",
    "main",
    "mod",
    "test",
    "tests",
    "schema",
    "config",
    "helper",
    "helpers",
    "engine",
    "pipeline",
    "plug",
    "plugs",
    "command",
    "commands",
    "index",
  ].map((w) => w.toLowerCase()),
);

export function isLocationQuery(query: string): boolean {
  return LOCATION_QUERY_RE.test(query);
}

export function isEntryPointQuery(query: string): boolean {
  return ENTRY_POINT_QUERY_RE.test(query);
}

function fileStemMatchesQuery(filePath: string, query: string): boolean {
  const stem = basename(filePath)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const rawTokens = (query.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g) ?? []).map((t) => t.toLowerCase());

  if (rawTokens.includes(stem)) {
    return true;
  }

  for (const token of rawTokens) {
    if (token.includes("-") && token.split("-").includes(stem)) {
      return false;
    }
  }

  const stemNorm = stem.replace(/[-_]/g, "");
  return rawTokens.some((t) => t.replace(/[-_]/g, "") === stemNorm);
}

export function isIntegrationQuery(query: string): boolean {
  return INTEGRATION_QUERY_RE.test(query);
}

function chunkLooksLikeEntryPoint(chunk: Chunk): boolean {
  if (PACKAGE_ENTRY_RE.test(chunk.content)) {
    return true;
  }
  return ENTRY_POINT_CONTENT_RE.test(chunk.content);
}

export function boostLocationSignals(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  allChunks: Chunk[],
  chunksByKey: Map<string, Chunk>,
): void {
  if (!isLocationQuery(query)) {
    return;
  }

  const entryPointQuery = isEntryPointQuery(query);
  const packageBoost = maxScore * (entryPointQuery ? LOCATION_BOOST_MULTIPLIER : 0.75);
  const codeBoost = maxScore * LOCATION_BOOST_MULTIPLIER;

  for (const chunk of allChunks) {
    if (!chunkLooksLikeEntryPoint(chunk)) {
      continue;
    }

    const isPackageEntry = PACKAGE_ENTRY_RE.test(chunk.content);
    if (isPackageEntry) {
      const key = chunkKey(chunk);
      boosted.set(key, (boosted.get(key) ?? 0) + packageBoost);
      chunksByKey.set(key, chunk);
      continue;
    }

    if (!entryPointQuery && !fileStemMatchesQuery(chunk.file_path, query)) {
      continue;
    }

    const key = chunkKey(chunk);
    boosted.set(key, (boosted.get(key) ?? 0) + codeBoost);
    chunksByKey.set(key, chunk);
  }
}

export function penalizeInstallerForLocation(
  boosted: Map<string, number>,
  query: string,
  chunksByKey: Map<string, Chunk>,
): void {
  if (!isLocationQuery(query) || isIntegrationQuery(query)) {
    return;
  }

  for (const [key, score] of boosted) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    if (INSTALLER_PATH_RE.test(chunk.file_path.replace(/\\/g, "/"))) {
      boosted.set(key, score * INSTALLER_LOCATION_PENALTY);
    }
  }
}

function hasSpecificImplementationTarget(query: string, chunksByKey: Map<string, Chunk>): boolean {
  const lowered = query.toLowerCase();
  for (const hint of IMPLEMENTATION_HINTS) {
    if (!lowered.includes(hint)) {
      continue;
    }
    for (const chunk of chunksByKey.values()) {
      const stem = basename(chunk.file_path)
        .replace(/\.[^.]+$/, "")
        .toLowerCase();
      if (stem === hint) {
        return true;
      }
    }
  }
  return false;
}

export function boostExactStemMatches(
  boosted: Map<string, number>,
  query: string,
  maxScore: number,
  chunksByKey: Map<string, Chunk>,
): void {
  const keywords = new Set(
    (query.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g) ?? [])
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase()),
  );
  if (keywords.size === 0) {
    return;
  }

  const boost = maxScore * 0.75;
  const preferImplementation = hasSpecificImplementationTarget(query, chunksByKey);

  for (const key of [...boosted.keys()]) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    const stem = basename(chunk.file_path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    const stemNorm = stem.replace(/[-_]/g, "");
    for (const keyword of keywords) {
      if (GENERIC_STEM_DENY.has(keyword)) {
        continue;
      }
      if (preferImplementation && stem === keyword && !IMPLEMENTATION_HINTS.has(stem)) {
        continue;
      }
      const keywordNorm = keyword.replace(/[-_]/g, "");
      if (stem === keyword || stemNorm === keywordNorm) {
        boosted.set(key, (boosted.get(key) ?? 0) + boost);
        break;
      }
      const parts = keyword.split("-").filter((p) => p.length > 2);
      if (parts.length > 1 && parts.some((p) => p === stem)) {
      }
    }
  }
}
