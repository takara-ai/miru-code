export type ChunkIndexMappings = {
  fileMapping: ReadonlyMap<string, readonly number[]>;
  languageMapping: ReadonlyMap<string, readonly number[]>;
};

/**
 * Union of chunk indices matching language and/or path filters. Path filters
 * match an exact indexed file path or every file below a directory prefix.
 *
 * Filters combine with OR semantics: a chunk is included if it matches any
 * requested language or path. Returns `undefined` when no filters are given
 * (search all chunks), and an empty array when filters match no chunks.
 *
 * Exact-file and single-language queries return the prebuilt map array
 * directly (read-only for callers). Directory and multi-filter queries
 * allocate an index list.
 */
export function buildChunkSelector(
  mappings: ChunkIndexMappings,
  filterLanguages?: readonly string[],
  filterPaths?: readonly string[],
): readonly number[] | undefined {
  const langCount = filterLanguages?.length ?? 0;
  const pathCount = filterPaths?.length ?? 0;

  if (langCount === 0 && pathCount === 0) {
    return undefined;
  }

  if (langCount === 1 && pathCount === 0) {
    const lang = filterLanguages?.[0];
    if (!lang) {
      return [];
    }
    const indices = mappings.languageMapping.get(lang);
    return indices && indices.length > 0 ? indices : [];
  }

  if (pathCount === 1 && langCount === 0) {
    const fp = filterPaths?.[0];
    if (!fp) {
      return [];
    }
    const normalized = normalizePathFilter(fp);
    const exact = [...mappings.fileMapping.entries()].find(
      ([filePath]) => filePath.replace(/\\/g, "/") === normalized,
    )?.[1];
    if (exact) {
      return exact;
    }
    const prefix = `${normalized}/`;
    return [...mappings.fileMapping.entries()]
      .filter(([filePath]) => filePath.replace(/\\/g, "/").startsWith(prefix))
      .flatMap(([, indices]) => indices);
  }

  const selector: number[] = [];
  for (const lang of filterLanguages ?? []) {
    selector.push(...(mappings.languageMapping.get(lang) ?? []));
  }
  for (const fp of filterPaths ?? []) {
    const normalized = normalizePathFilter(fp);
    const exact = [...mappings.fileMapping.entries()].find(
      ([filePath]) => filePath.replace(/\\/g, "/") === normalized,
    )?.[1];
    if (exact) {
      selector.push(...exact);
      continue;
    }
    const prefix = `${normalized}/`;
    for (const [filePath, indices] of mappings.fileMapping) {
      if (filePath.replace(/\\/g, "/").startsWith(prefix)) {
        selector.push(...indices);
      }
    }
  }
  if (selector.length === 0) {
    return [];
  }
  return [...new Set(selector)];
}

function normalizePathFilter(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
