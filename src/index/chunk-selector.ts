export type ChunkIndexMappings = {
  fileMapping: ReadonlyMap<string, readonly number[]>;
  languageMapping: ReadonlyMap<string, readonly number[]>;
};

/**
 * Union of chunk indices matching language and/or path filters.
 *
 * Filters combine with OR semantics: a chunk is included if it matches any
 * requested language or path. Returns `undefined` when no filters are given
 * (search all chunks) or when no chunks match.
 *
 * Single-filter queries return the prebuilt map array directly (read-only for
 * callers). Multi-filter queries allocate a deduped index list.
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
      return undefined;
    }
    const indices = mappings.languageMapping.get(lang);
    return indices && indices.length > 0 ? indices : undefined;
  }

  if (pathCount === 1 && langCount === 0) {
    const fp = filterPaths?.[0];
    if (!fp) {
      return undefined;
    }
    const indices = mappings.fileMapping.get(fp);
    return indices && indices.length > 0 ? indices : undefined;
  }

  const selector: number[] = [];
  for (const lang of filterLanguages ?? []) {
    selector.push(...(mappings.languageMapping.get(lang) ?? []));
  }
  for (const fp of filterPaths ?? []) {
    selector.push(...(mappings.fileMapping.get(fp) ?? []));
  }
  if (selector.length === 0) {
    return undefined;
  }
  return [...new Set(selector)];
}
