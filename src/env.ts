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

const EMBEDDING_API_KEY_NAMES = [
  "TAKARA_API_KEY",
  "OPENAI_API_KEY",
  "MIRU_OPENAI_API_KEY",
  "SEMBLE_OPENAI_API_KEY",
] as const;

export function resolveEmbeddingApiKey(): string {
  const key = envFirstString([...EMBEDDING_API_KEY_NAMES], "");
  if (!key) {
    throw new Error(
      "Embedding API key required. Set TAKARA_API_KEY, OPENAI_API_KEY, MIRU_OPENAI_API_KEY, or SEMBLE_OPENAI_API_KEY " +
        "in your MCP server env (Cursor mcp.json) or .env.local.",
    );
  }
  return key;
}
