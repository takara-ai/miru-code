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

export function hasTakaraApiKeyInEnv(): boolean {
  return Boolean(process.env[TAKARA_API_KEY_ENV]?.trim());
}

export function resolveEmbeddingApiKey(): string {
  const key = process.env[TAKARA_API_KEY_ENV]?.trim() ?? "";
  if (!key) {
    throw new Error(
      "Takara API key required. Run `miru setup`, or set TAKARA_API_KEY in your MCP server env or .env.local.",
    );
  }
  return key;
}
