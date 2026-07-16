import type { ExpandResults } from "../utils.ts";

/** Plain-text rendering of `formatResults()` output — same info as the JSON shape, no scaffolding. */
export function formatResultsText(payload: {
  query: string;
  results: Record<string, unknown>[];
}): string {
  if (payload.results.length === 0) {
    return "No results found.";
  }

  const blocks = payload.results.map((result) => {
    const chunk = result.chunk as Record<string, unknown>;
    const startLine = chunk.truncated ? chunk.full_start_line : chunk.start_line;
    const endLine = chunk.truncated ? chunk.full_end_line : chunk.end_line;
    const truncatedNote = chunk.truncated ? " [truncated: call expand for full chunk]" : "";
    const header = `${chunk.file_path}:${startLine}-${endLine}${truncatedNote}`;
    return `${header}\n${chunk.content}`;
  });

  return blocks.join("\n\n");
}

/** Plain-text rendering of `formatLiteralLocate()` output. */
export function formatLiteralLocateText(payload: Record<string, unknown>): string {
  const label =
    (payload.literals as string[] | undefined)?.join(" | ") ?? (payload.literal as string);
  const n = payload.n as number;
  const files = payload.files as number;
  const truncatedNote = payload.truncated ? " (truncated — pass a narrower include/exclude)" : "";
  const header = `"${label}": ${n} match${n === 1 ? "" : "es"} across ${files} file${files === 1 ? "" : "s"}${truncatedNote}`;

  const hits = payload.hits as
    | Array<{ f: string; l: number; t?: string; ctx?: string[]; ctx_l?: number }>
    | undefined;
  if (!hits) {
    return header;
  }

  const lines = [header, ""];
  for (const hit of hits) {
    lines.push(hit.t !== undefined ? `${hit.f}:${hit.l}: ${hit.t}` : `${hit.f}:${hit.l}`);
    if (hit.ctx != null && hit.ctx_l !== undefined) {
      const ctxStart = hit.ctx_l;
      for (let i = 0; i < hit.ctx.length; i++) {
        lines.push(`  ${ctxStart + i}: ${hit.ctx[i]}`);
      }
    }
  }
  return lines.join("\n");
}

/** Plain-text rendering of `formatExpandResults()` output. */
export function formatExpandResultsText(payload: ExpandResults): string {
  const anchorRange = payload.anchor
    ? `${payload.anchor.start_line}-${payload.anchor.end_line}`
    : null;
  const header = `${payload.file_path} — ${payload.chunk_count} chunk${payload.chunk_count === 1 ? "" : "s"} around line ${payload.line}`;

  const blocks = payload.chunks.map((chunk) => {
    const range = `${chunk.start_line}-${chunk.end_line}`;
    const isAnchor = anchorRange === range;
    return `${range}${isAnchor ? " (anchor)" : ""}\n${chunk.content}`;
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
}
