import {
  type ChunkBoundary,
  type LineGroup,
  mergeAdjacentChunks,
  splitLinesKeepEnds,
} from "./lines.ts";

const SUPPORTED_STRUCTURAL_LANGUAGES = new Set(["python", "go", "typescript", "javascript"]);

export function chunkStructural(
  source: string,
  language: string | null,
  desiredLength: number,
): ChunkBoundary[] | null {
  if (!language || !SUPPORTED_STRUCTURAL_LANGUAGES.has(language)) {
    return null;
  }

  const lines = splitLinesKeepEnds(source);
  if (lines.length === 0) {
    return [];
  }

  let units: ChunkBoundary[];
  if (language === "python") {
    units = pythonUnits(lines);
  } else {
    units = braceUnits(lines, language);
  }

  if (units.length === 0) {
    return null;
  }
  return mergeAdjacentChunks(units, desiredLength);
}

function lineIndent(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    i++;
  }
  return i;
}

function stripLine(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

function _isBlank(text: string): boolean {
  return stripLine(text).trim().length === 0;
}

function _isCommentLine(text: string, language: string): boolean {
  const trimmed = stripLine(text).trim();
  if (language === "python") {
    return trimmed.startsWith("#");
  }
  return trimmed.startsWith("//");
}

function pythonUnits(lines: LineGroup[]): ChunkBoundary[] {
  const units: ChunkBoundary[] = [];
  let firstDeclStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripLine(lines[i]?.text);
    const trimmed = raw.trim();
    if (!trimmed.match(/^(async\s+def|def|class)\b/)) {
      continue;
    }
    if (firstDeclStart === null) {
      firstDeclStart = lines[i]?.start;
    }

    const declIndent = lineIndent(raw);

    if (trimmed.startsWith("class ")) {
      const classEndLine = findPythonBlockEnd(lines, i, declIndent);
      const methodStarts: number[] = [];
      for (let j = i + 1; j <= classEndLine; j++) {
        const innerRaw = stripLine(lines[j]?.text);
        const innerTrim = innerRaw.trim();
        if (!innerTrim.match(/^(async\s+def|def)\b/)) {
          continue;
        }
        if (lineIndent(innerRaw) > declIndent) {
          methodStarts.push(j);
        }
      }

      if (methodStarts.length > 0) {
        const firstMethodStart = methodStarts[0];
        if (firstMethodStart === undefined) {
          continue;
        }
        const firstMethodEnd = findPythonBlockEnd(
          lines,
          firstMethodStart,
          lineIndent(stripLine(lines[firstMethodStart]?.text)),
        );
        units.push({ start: lines[i]?.start, end: lines[firstMethodEnd]?.end });
        for (let m = 1; m < methodStarts.length; m++) {
          const methodStart = methodStarts[m];
          if (methodStart === undefined) {
            continue;
          }
          const methodIndent = lineIndent(stripLine(lines[methodStart]?.text));
          const methodEnd = findPythonBlockEnd(lines, methodStart, methodIndent);
          units.push({ start: lines[methodStart]?.start, end: lines[methodEnd]?.end });
        }
      } else {
        units.push({ start: lines[i]?.start, end: lines[classEndLine]?.end });
      }
      continue;
    }

    let startLine = i;
    while (startLine - 1 >= 0) {
      const prev = stripLine(lines[startLine - 1]?.text).trim();
      if (prev.startsWith("@")) {
        startLine--;
        continue;
      }
      break;
    }

    const endLine = findPythonBlockEnd(lines, i, declIndent);

    // Keep top-level defs and class blocks; methods are represented by their class block.
    if (declIndent > 0) {
      continue;
    }

    const start = lines[startLine]?.start;
    const end = lines[endLine]?.end;
    if (end > start) {
      units.push({ start, end });
    }
  }

  if (firstDeclStart !== null && firstDeclStart > 0) {
    units.unshift({ start: 0, end: firstDeclStart });
  }

  return dedupeAndSort(units);
}

function findPythonBlockEnd(lines: LineGroup[], start: number, indent: number): number {
  let endLine = lines.length - 1;
  for (let j = start + 1; j < lines.length; j++) {
    const nextRaw = stripLine(lines[j]?.text);
    if (!nextRaw.trim() || nextRaw.trim().startsWith("#")) {
      continue;
    }
    if (lineIndent(nextRaw) <= indent) {
      endLine = j - 1;
      break;
    }
  }
  return endLine;
}

function declPattern(language: string): RegExp {
  if (language === "go") {
    return /^\s*(func\b|type\b.*\b(struct|interface)\b)/;
  }
  return /^\s*(export\s+)?(async\s+function\b|function\b|class\b|interface\b|type\b|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>)/;
}

function braceUnits(lines: LineGroup[], language: string): ChunkBoundary[] {
  const units: ChunkBoundary[] = [];
  const full = lines.map((l) => l.text).join("");
  const re = declPattern(language);
  let firstDeclStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = stripLine(lines[i]?.text);
    if (!re.test(text)) {
      continue;
    }
    if (firstDeclStart === null) {
      firstDeclStart = lines[i]?.start;
    }

    const startOffset = lines[i]?.start;
    const openPos = full.indexOf("{", startOffset);
    if (openPos === -1) {
      continue;
    }

    const limit = i + 60 < lines.length ? lines[i + 60]?.end : full.length;
    if (openPos >= limit) {
      continue;
    }

    let depth = 0;
    let endPos = -1;
    for (let p = openPos; p < full.length; p++) {
      const ch = full[p];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endPos = p + 1;
          break;
        }
      }
    }
    if (endPos > startOffset) {
      let extendedEnd = endPos;
      while (
        extendedEnd < full.length &&
        (full[extendedEnd] === ";" || full[extendedEnd] === " " || full[extendedEnd] === "\t")
      ) {
        extendedEnd++;
      }
      if (extendedEnd < full.length && full[extendedEnd] === "\n") {
        extendedEnd++;
      }
      units.push({ start: startOffset, end: extendedEnd });
    }
  }

  if (firstDeclStart !== null && firstDeclStart > 0) {
    units.unshift({ start: 0, end: firstDeclStart });
  }

  return dedupeAndSort(units);
}

function dedupeAndSort(units: ChunkBoundary[]): ChunkBoundary[] {
  const out: ChunkBoundary[] = [];
  const seen = new Set<string>();
  for (const u of units.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const key = `${u.start}:${u.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(u);
  }
  return out;
}
