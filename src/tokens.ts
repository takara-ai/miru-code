const TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_]*/g;
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

export function splitIdentifier(token: string): string[] {
  const lower = token.toLowerCase();
  let parts: string[];

  if (token.includes("_")) {
    parts = lower.split("_").filter(Boolean);
  } else {
    parts = (token.match(CAMEL_RE) ?? []).map((m) => m.toLowerCase());
  }

  if (parts.length >= 2) {
    return [lower, ...parts];
  }
  return [lower];
}

export function tokenize(text: string): string[] {
  const raw = text.match(TOKEN_RE) ?? [];
  const result: string[] = [];
  for (const tok of raw) {
    result.push(...splitIdentifier(tok));
  }
  return result;
}
