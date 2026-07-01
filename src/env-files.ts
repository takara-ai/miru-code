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

async function loadEnvFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return;
  }
  for (const line of (await file.text()).split("\n")) {
    applyEnvLine(line);
  }
}

/** Load .env.local / .env without overriding vars already set (e.g. MCP config env). */
export async function loadEnvFiles(options?: {
  packageRoot?: string;
  cwd?: string;
}): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  const packageRoot = options?.packageRoot ?? join(import.meta.dir, "..");
  for (const dir of [packageRoot, cwd]) {
    await loadEnvFile(join(dir, ".env.local"));
    await loadEnvFile(join(dir, ".env"));
  }
}
