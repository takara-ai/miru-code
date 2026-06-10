export function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function envFirstString(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return fallback;
}

export function envOptionalInt(names: string[], min = 1): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min) {
      return Math.floor(n);
    }
  }
  return undefined;
}

export const TAKARA_API_KEY_ENV = "TAKARA_API_KEY";

const MCP_KEY_PLACEHOLDER = "$" + "{TAKARA_API_KEY}";
const TAKARA_API_KEY_PLACEHOLDERS = new Set([MCP_KEY_PLACEHOLDER, "$TAKARA_API_KEY"]);

/** True when the value is a real key, not empty or an unexpanded MCP env placeholder. */
export function isUsableTakaraApiKey(value: string | undefined): boolean {
  const key = value?.trim() ?? "";
  if (!key) {
    return false;
  }
  return !TAKARA_API_KEY_PLACEHOLDERS.has(key);
}

/** Drop placeholder values so credentials.json can supply the key for MCP. */
export function normalizeTakaraApiKeyEnv(): void {
  if (!isUsableTakaraApiKey(process.env[TAKARA_API_KEY_ENV])) {
    delete process.env[TAKARA_API_KEY_ENV];
  }
}

export function hasTakaraApiKeyInEnv(): boolean {
  return isUsableTakaraApiKey(process.env[TAKARA_API_KEY_ENV]);
}

export function resolveEmbeddingApiKey(): string {
  const key = process.env[TAKARA_API_KEY_ENV]?.trim() ?? "";
  if (!isUsableTakaraApiKey(key)) {
    throw new Error(
      "Takara API key required. Run `miru setup`, or set TAKARA_API_KEY in your MCP server env or .env.local.",
    );
  }
  return key;
}
