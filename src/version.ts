import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json";
import { resolveCacheFolder } from "./cache.ts";
import { hint, writeStderr } from "./cli-ui.ts";

const PACKAGE_NAME = "@takara-ai/miru-code";
const REGISTRY_URL = "https://registry.npmjs.org/@takara-ai%2Fmiru-code";
const UPDATE_CHECK_FILENAME = "update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2_000;

interface UpdateCheckCache {
  checkedAt: number;
  latest: string;
}

export function miruVersion(): string {
  return packageJson.version;
}

/**
 * Index cache epoch — zero-copy from package.json semver.
 * - 0.x releases: `0.{minor}` (chunking may break on minor bumps pre-1.0).
 * - 1.x+: major version only.
 */
export function indexCacheEpoch(): string {
  const parts = packageJson.version.split(".");
  const major = parts[0] ?? "0";
  const minor = parts[1] ?? "0";
  if (major === "0") {
    return `0.${minor}`;
  }
  return major;
}

export function isVersionNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const match = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) {
    return latest !== current;
  }

  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) {
      return true;
    }
    if (a[i]! < b[i]!) {
      return false;
    }
  }
  return false;
}

function updateCheckPath(): string {
  return join(resolveCacheFolder(), UPDATE_CHECK_FILENAME);
}

async function readUpdateCheckCache(): Promise<UpdateCheckCache | null> {
  try {
    const raw = await readFile(updateCheckPath(), "utf-8");
    const parsed = JSON.parse(raw) as UpdateCheckCache;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeUpdateCheckCache(latest: string): Promise<void> {
  const payload: UpdateCheckCache = { checkedAt: Date.now(), latest };
  await writeFile(updateCheckPath(), `${JSON.stringify(payload)}\n`, "utf-8");
}

export async function fetchLatestPublishedVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`registry ${response.status}`);
  }
  const body = (await response.json()) as { "dist-tags"?: { latest?: string } };
  const latest = body["dist-tags"]?.latest;
  if (!latest) {
    throw new Error("missing dist-tags.latest");
  }
  return latest;
}

/** Print update hint to stderr when a newer package is on npm (at most once per day). */
export async function maybeNotifyUpdate(): Promise<void> {
  if (process.env.MIRU_NO_UPDATE_CHECK === "1") {
    return;
  }

  const current = miruVersion();
  const cached = await readUpdateCheckCache();
  if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    if (isVersionNewer(cached.latest, current)) {
      writeUpdateNotice(cached.latest, current);
    }
    return;
  }

  try {
    const latest = await fetchLatestPublishedVersion();
    await writeUpdateCheckCache(latest);
    if (isVersionNewer(latest, current)) {
      writeUpdateNotice(latest, current);
    }
  } catch {
    // Offline or registry unreachable — skip silently.
  }
}

function writeUpdateNotice(latest: string, current: string): void {
  writeStderr();
  hint(
    `Update available: ${latest} (you have ${current}). Run: bun add -g ${PACKAGE_NAME}`,
    process.stderr,
  );
  writeStderr();
}
