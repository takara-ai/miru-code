import { hasRegexLiteral } from "../literal.ts";
import type { ExpandResults } from "../utils.ts";

/** Plain-text rendering of `formatResults()` output — same info as the JSON shape, no scaffolding. */
export function formatResultsText(payload: {
  query: string;
  results: Record<string, unknown>[];
}): string {
  if (payload.results.length === 0) {
    return "No results found.";
  }

  let hasTruncated = false;
  const blocks = payload.results.map((result) => {
    const chunk = result.chunk as Record<string, unknown>;
    // A truncated hit names the matched symbol's exact range (not the source file's) so the full
    // body is one ranged read away; `anchor_line` is the matched line for `expand`/`find_related`.
    const startLine = chunk.truncated
      ? (chunk.match_start_line ?? chunk.full_start_line)
      : chunk.start_line;
    const endLine = chunk.truncated
      ? (chunk.match_end_line ?? chunk.full_end_line)
      : chunk.end_line;
    const symbol = chunk.truncated && chunk.symbol ? ` ${chunk.symbol}` : "";
    const truncatedNote = chunk.truncated ? ` [truncated: anchor_line ${chunk.anchor_line}]` : "";
    if (chunk.truncated) hasTruncated = true;
    const header = `${chunk.file_path}:${startLine}-${endLine}${symbol}${truncatedNote}`;
    return `${header}\n${chunk.content}`;
  });

  if (hasTruncated) {
    blocks.push(
      "For truncated hits, read the header's line range; use expand for neighbouring chunks.",
    );
  }
  return blocks.join("\n\n");
}

/** Very long lines (minified bundles, lockfiles) cost far more than they inform. */
const MAX_LINE_CHARS = 400;

function clipLine(text: string): string {
  return text.length > MAX_LINE_CHARS
    ? `${text.slice(0, MAX_LINE_CHARS)}… [+${text.length - MAX_LINE_CHARS} chars]`
    : text;
}

/** Group sorted repo-relative paths by directory so each directory prints once. */
export function formatPathList(paths: readonly string[]): string {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "./" : path.slice(0, slash + 1);
    const names = byDir.get(dir);
    const name = slash < 0 ? path : path.slice(slash + 1);
    if (names) {
      names.push(name);
    } else {
      byDir.set(dir, [name]);
    }
  }
  // A directory holding one match prints as a plain path; grouping only pays off for two or more.
  return [...byDir]
    .map(([dir, names]) =>
      names.length === 1
        ? `${dir === "./" ? "" : dir}${names[0]}`
        : `${dir}\n  ${names.join("\n  ")}`,
    )
    .join("\n");
}

/** Plain-text rendering of `formatLiteralLocate()` output. */
export function formatLiteralLocateText(payload: Record<string, unknown>): string {
  const label =
    (payload.literals as string[] | undefined)?.join(" | ") ?? (payload.literal as string);
  const n = payload.n as number;
  const files = payload.files as number;
  const truncatedNote = payload.truncated ? " (truncated — pass a narrower include/exclude)" : "";
  const fileCount = `${files} file${files === 1 ? "" : "s"}`;
  // Short plain literals are worth echoing; a regex the caller just sent is not (it tokenizes poorly).
  const counts = `${n} match${n === 1 ? "" : "es"} across ${fileCount}${truncatedNote}`;
  const header = !label
    ? fileCount
    : hasRegexLiteral(label.split(" | "))
      ? counts
      : `"${label}": ${counts}`;

  const paths = payload.paths as string[] | undefined;
  if (paths) {
    return paths.length === 0 ? header : `${header}\n\n${formatPathList(paths)}`;
  }

  const hits = payload.hits as
    | Array<{ f: string; l: number; t?: string; ctx?: string[]; ctx_l?: number }>
    | undefined;
  if (!hits) {
    return header;
  }

  const lines = [header, ""];
  if (hits.some((hit) => hit.ctx != null)) {
    for (const hit of hits) {
      lines.push(
        hit.t !== undefined ? `${hit.f}:${hit.l}: ${clipLine(hit.t)}` : `${hit.f}:${hit.l}`,
      );
      if (hit.ctx != null && hit.ctx_l !== undefined) {
        const ctxStart = hit.ctx_l;
        for (let i = 0; i < hit.ctx.length; i++) {
          lines.push(`  ${ctxStart + i}: ${clipLine(hit.ctx[i] ?? "")}`);
        }
      }
    }
    return lines.join("\n");
  }

  // Each path once: `path` then indented `line: text`, or `path: 3, 9, 40` without text.
  const byFile = new Map<string, Array<{ l: number; t?: string }>>();
  for (const hit of hits) {
    const group = byFile.get(hit.f);
    if (group) {
      group.push({ l: hit.l, t: hit.t });
    } else {
      byFile.set(hit.f, [{ l: hit.l, t: hit.t }]);
    }
  }
  for (const [file, group] of byFile) {
    if (group.every((hit) => hit.t === undefined)) {
      lines.push(`${file}: ${group.map((hit) => hit.l).join(", ")}`);
    } else if (group.length === 1) {
      lines.push(`${file}:${group[0]?.l}: ${clipLine(group[0]?.t ?? "")}`);
    } else {
      lines.push(file);
      for (const hit of group) {
        lines.push(`  ${hit.l}: ${clipLine(hit.t ?? "")}`);
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
