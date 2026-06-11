import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchResult } from "../src/types.ts";

export const BENCH_ROOT = join(process.env.HOME ?? "", ".cache", "miru-bench");
export const ANNOTATIONS_DIR = "/tmp/miru-research/benchmarks/annotations";
export const REPOS_PATH = "/tmp/miru-research/benchmarks/repos.json";

export interface Target {
  path: string;
  start_line: number | null;
  end_line: number | null;
}

export interface RepoSpec {
  name: string;
  language: string;
  benchmark_root: string | null;
}

export interface BenchmarkTask {
  repo: string;
  language: string;
  query: string;
  allRelevant: Target[];
  category: string;
}

export function parseTarget(raw: string | Record<string, unknown>): Target {
  if (typeof raw === "string") {
    return { path: raw, start_line: null, end_line: null };
  }
  const start = raw.start_line;
  const end = raw.end_line;
  return {
    path: String(raw.path),
    start_line: start == null ? null : Number(start),
    end_line: end == null ? null : Number(end),
  };
}

export function inferCategory(query: string): string {
  if (!query.trim().includes(" ")) {
    return "symbol";
  }
  const lowered = query.toLowerCase();
  if (
    lowered.startsWith("how ") ||
    lowered.startsWith("how does") ||
    lowered.startsWith("how are")
  ) {
    return "architecture";
  }
  return "semantic";
}

export async function loadRepoSpecs(): Promise<Map<string, RepoSpec>> {
  const raw = JSON.parse(await readFile(REPOS_PATH, "utf-8")) as Array<{
    name: string;
    language: string;
    benchmark_root?: string | null;
  }>;
  const specs = new Map<string, RepoSpec>();
  for (const item of raw) {
    specs.set(item.name, {
      name: item.name,
      language: item.language,
      benchmark_root: item.benchmark_root ?? null,
    });
  }
  return specs;
}

export function requireRepoSpec(specs: Map<string, RepoSpec>, name: string): RepoSpec {
  const spec = specs.get(name);
  if (!spec) {
    throw new Error(`Missing repo spec: ${name}`);
  }
  return spec;
}

export function benchmarkDir(spec: RepoSpec): string {
  const checkout = join(BENCH_ROOT, spec.name);
  return spec.benchmark_root ? join(checkout, spec.benchmark_root) : checkout;
}

export async function loadBenchmarkTasks(
  specs: Map<string, RepoSpec>,
  repoFilter: Set<string> | null,
): Promise<BenchmarkTask[]> {
  const tasks: BenchmarkTask[] = [];
  const files = (await readdir(ANNOTATIONS_DIR)).filter((f) => f.endsWith(".json"));
  for (const file of files.sort()) {
    const repoName = file.replace(/\.json$/, "");
    if (!specs.has(repoName)) {
      continue;
    }
    const spec = requireRepoSpec(specs, repoName);
    try {
      await Bun.file(join(BENCH_ROOT, spec.name)).stat();
    } catch {
      continue;
    }
    const raw = JSON.parse(await readFile(join(ANNOTATIONS_DIR, file), "utf-8")) as Array<
      Record<string, unknown>
    >;
    for (const item of raw) {
      const repo = String(item.repo ?? repoName);
      if (repo !== spec.name) {
        continue;
      }
      if (repoFilter && !repoFilter.has(repo)) {
        continue;
      }
      const relevant = [
        ...((item.relevant as Array<string | Record<string, unknown>> | undefined) ?? []),
        ...((item.secondary as Array<string | Record<string, unknown>> | undefined) ?? []),
      ].map(parseTarget);
      tasks.push({
        repo,
        language: spec.language,
        query: String(item.query),
        allRelevant: relevant,
        category:
          typeof item.category === "string" ? item.category : inferCategory(String(item.query)),
      });
    }
  }
  return tasks;
}

export function pathMatches(filePath: string, targetPath: string): boolean {
  const normFile = filePath.replaceAll("\\", "/");
  const normTarget = targetPath.replaceAll("\\", "/");
  return (
    normFile === normTarget ||
    normFile.endsWith(`/${normTarget}`) ||
    normTarget.endsWith(`/${normFile}`)
  );
}

export function targetMatchesLocation(
  filePath: string,
  startLine: number,
  endLine: number,
  target: Target,
): boolean {
  if (!pathMatches(filePath, target.path)) {
    return false;
  }
  if (target.start_line == null || target.end_line == null) {
    return true;
  }
  return !(endLine < target.start_line || startLine > target.end_line);
}

export function targetRank(results: SearchResult[], target: Target): number | null {
  for (let i = 0; i < results.length; i++) {
    const chunk = results[i]?.chunk;
    if (chunk && targetMatchesLocation(chunk.file_path, chunk.start_line, chunk.end_line, target)) {
      return i + 1;
    }
  }
  return null;
}

function dcg(relevances: number[]): number {
  return relevances.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

export function ndcgAtK(relevantRanks: number[], nRelevant: number, k: number): number {
  if (nRelevant === 0) {
    return 0;
  }
  const relevances = Array.from({ length: k }, () => 0);
  for (const rank of relevantRanks) {
    if (rank >= 1 && rank <= k) {
      relevances[rank - 1] = 1;
    }
  }
  const ideal = dcg(Array.from({ length: Math.min(k, nRelevant) }, () => 1));
  return ideal > 0 ? dcg(relevances) / ideal : 0;
}

export function groupByRepo<T extends { repo: string }>(tasks: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const list = groups.get(task.repo) ?? [];
    list.push(task);
    groups.set(task.repo, list);
  }
  return groups;
}

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
