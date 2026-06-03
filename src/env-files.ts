import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function applyEnvLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return;
  }
  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    return;
  }
  const key = trimmed.slice(0, eq).trim();
  if (!key || process.env[key] !== undefined) {
    return;
  }
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    applyEnvLine(line);
  }
}

/** Load .env.local / .env without overriding vars already set (e.g. MCP config env). */
export function loadEnvFiles(options?: { packageRoot?: string; cwd?: string }): void {
  const cwd = options?.cwd ?? process.cwd();
  const packageRoot = options?.packageRoot ?? join(import.meta.dir, "..");
  for (const dir of [packageRoot, cwd]) {
    loadEnvFile(join(dir, ".env.local"));
    loadEnvFile(join(dir, ".env"));
  }
}
