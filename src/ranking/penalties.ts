import { basename } from "node:path";
import type { Chunk } from "../types.ts";

const TEST_FILE_RE =
  /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go|[^/]*Tests?\.java|[^/]*Test\.php|[^/]*_spec\.rb|[^/]*_test\.rb|[^/]*\.test\.[jt]sx?|[^/]*\.spec\.[jt]sx?|[^/]*Tests?\.kt|[^/]*Spec\.kt|[^/]*Tests?\.swift|[^/]*Spec\.swift|[^/]*Tests?\.cs|test_[^/]*\.cpp|[^/]*_test\.cpp|test_[^/]*\.c|[^/]*_test\.c|[^/]*Spec\.scala|[^/]*Suite\.scala|[^/]*Test\.scala|[^/]*_test\.dart|test_[^/]*\.dart|[^/]*_spec\.lua|[^/]*_test\.lua|test_[^/]*\.lua|test_helpers?[^/]*\.\w+)$/;

const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec|testing)(?:\/|$)/;
const COMPAT_DIR_RE = /(?:^|\/)(?:compat|_compat|legacy)(?:\/|$)/;
const EXAMPLES_DIR_RE = /(?:^|\/)(?:_?examples?|docs?_src)(?:\/|$)/;
const TYPE_DEFS_RE = /\.d\.ts$/;

const STRONG_PENALTY = 0.3;
const MODERATE_PENALTY = 0.5;
const MILD_PENALTY = 0.7;

const REEXPORT_FILENAMES = new Set(["__init__.py", "package-info.java"]);
const FILE_SATURATION_THRESHOLD = 1;
const FILE_SATURATION_DECAY = 0.5;

function filePathPenalty(filePath: string): number {
  const normalised = filePath.replace(/\\/g, "/");
  let penalty = 1.0;
  if (TEST_FILE_RE.test(normalised) || TEST_DIR_RE.test(normalised)) {
    penalty *= STRONG_PENALTY;
  }
  if (REEXPORT_FILENAMES.has(basename(filePath))) {
    penalty *= MODERATE_PENALTY;
  }
  if (COMPAT_DIR_RE.test(normalised)) {
    penalty *= STRONG_PENALTY;
  }
  if (EXAMPLES_DIR_RE.test(normalised)) {
    penalty *= STRONG_PENALTY;
  }
  if (TYPE_DEFS_RE.test(normalised)) {
    penalty *= MILD_PENALTY;
  }
  return penalty;
}

export function rerankTopk(
  scores: Map<string, number>,
  chunksByKey: Map<string, Chunk>,
  topK: number,
  penalisePaths = true,
): [Chunk, number][] {
  if (scores.size === 0) {
    return [];
  }

  const penaltyCache = new Map<string, number>();
  const penalised = new Map<string, number>();

  for (const [key, score] of scores) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }
    let pen = score;
    if (penalisePaths) {
      let mult = penaltyCache.get(chunk.file_path);
      if (mult === undefined) {
        mult = filePathPenalty(chunk.file_path);
        penaltyCache.set(chunk.file_path, mult);
      }
      pen *= mult;
    }
    penalised.set(key, pen);
  }

  const ranked = [...penalised.entries()].sort((a, b) => b[1] - a[1]);

  const fileSelected = new Map<string, number>();
  const selected: { score: number; key: string }[] = [];
  let minSelected = Infinity;

  for (const [key, penScore] of ranked) {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      continue;
    }

    if (selected.length >= topK && penScore <= minSelected) {
      break;
    }

    const already = fileSelected.get(chunk.file_path) ?? 0;
    let effScore = penScore;
    if (already >= FILE_SATURATION_THRESHOLD) {
      const excess = already - FILE_SATURATION_THRESHOLD + 1;
      effScore *= FILE_SATURATION_DECAY ** excess;
    }

    selected.push({ score: effScore, key });
    fileSelected.set(chunk.file_path, already + 1);

    if (selected.length >= topK) {
      minSelected = Math.min(...selected.map((s) => s.score));
    }
  }

  selected.sort((a, b) => b.score - a.score);
  return selected.slice(0, topK).flatMap(({ key, score }) => {
    const chunk = chunksByKey.get(key);
    if (!chunk) {
      return [];
    }
    return [[chunk, score] as [Chunk, number]];
  });
}
