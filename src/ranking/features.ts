/** Toggle search ranking/indexing improvements (A/B via MIRU_SEARCH_V2=0|1). */
export function searchImprovementsEnabled(): boolean {
  const value = process.env.MIRU_SEARCH_V2;
  if (value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  return true;
}
