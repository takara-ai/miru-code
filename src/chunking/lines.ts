export interface ChunkBoundary {
  start: number;
  end: number;
}

export interface LineGroup extends ChunkBoundary {
  text: string;
}

export function mergeAdjacentChunks(
  chunks: ChunkBoundary[],
  desiredLength: number,
): ChunkBoundary[] {
  if (chunks.length === 0) {
    return [];
  }

  const first = chunks[0];
  if (!first) {
    return [];
  }

  const merged: ChunkBoundary[] = [];
  let currentStart = first.start;
  let currentEnd = first.end;
  let currentLength = currentEnd - currentStart;

  for (const group of chunks.slice(1)) {
    const start = group.start;
    const end = group.end;
    const length = end - start;

    if (currentLength + length > desiredLength) {
      merged.push({ start: currentStart, end: currentEnd });
      currentStart = start;
      currentEnd = end;
      currentLength = length;
      continue;
    }

    currentEnd = end;
    currentLength += length;
  }

  merged.push({ start: currentStart, end: currentEnd });
  return merged;
}

export function splitLinesKeepEnds(source: string): LineGroup[] {
  const groups: LineGroup[] = [];
  const re = /.*(?:\r\n|\n|\r|$)/g;
  let match = re.exec(source);
  while (match !== null) {
    const text = match[0] ?? "";
    if (text.length === 0) {
      break;
    }
    const start = match.index;
    const end = start + text.length;
    groups.push({ start, end, text });
    if (re.lastIndex >= source.length) {
      break;
    }
    match = re.exec(source);
  }
  return groups;
}

export function chunkLines(source: string, desiredLength: number): ChunkBoundary[] {
  if (!source.trim()) {
    return [];
  }

  const lineGroups = splitLinesKeepEnds(source).map(({ start, end }) => ({
    start,
    end,
  }));
  return mergeAdjacentChunks(lineGroups, desiredLength);
}
