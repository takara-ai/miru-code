import { extname } from "node:path";
import { mapPool } from "../concurrency.ts";
import { getExtensions } from "../index/files.ts";
import { defaultContentTypes } from "../types.ts";
import type { SharedIndexClient } from "./client.ts";

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, status] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { bytes, error, status };
}

async function readGit(args: string[]) {
  const result = await git(args);
  if (result.status !== 0) throw new Error(result.error.trim() || "Git command failed.");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
}

const validCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function syncGit(
  client: SharedIndexClient,
  repository: string,
  target: string,
  base?: string,
) {
  if ((await readGit(["rev-parse", "--show-prefix"])).trim()) {
    throw new Error("Run sync-git from the repository root.");
  }
  if (![target, ...(base ? [base] : [])].every((sha) => validCommit.test(sha))) {
    throw new Error("Pass full Git commit object IDs for the target and optional base.");
  }
  if (base && (await git(["merge-base", "--is-ancestor", base, target])).status !== 0) {
    throw new Error("The base must be an ancestor of the target.");
  }

  const paths = base
    ? await readGit(["diff", "--no-renames", "--name-only", "-z", base, target, "--"])
    : await readGit(["ls-tree", "-rz", "--name-only", target, "--"]);
  const extensions = new Set(getExtensions(defaultContentTypes()));
  const sources = paths
    .split("\0")
    .filter(
      (path) =>
        extensions.has(extname(path).toLowerCase()) ||
        path.split("/").at(-1)?.toLowerCase() === "dockerfile",
    );
  const updates = await mapPool(sources, 3, async (path) => {
    const { revision } = await client.revision(repository, path);
    if (revision === target) return { state: "unchanged", embeddedChunks: 0 };
    if (
      revision &&
      (!validCommit.test(revision) ||
        (await git(["merge-base", "--is-ancestor", revision, target])).status !== 0)
    ) {
      throw new Error(`Cannot replace ${path} at a newer or unrelated revision.`);
    }

    const entry = await readGit(["--literal-pathspecs", "ls-tree", "-z", target, "--", path]);
    const blobMatch = /^(?:100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
    let content: string | null = null;
    if (blobMatch?.[1]) {
      const blob = blobMatch[1];
      const size = Number(await readGit(["cat-file", "-s", blob]));
      if (size > 128_000) throw new Error(`${path} exceeds the shared-index 128 KB file limit.`);
      content = await readGit(["cat-file", "blob", blob]);
    } else if (!revision) {
      return { state: "unchanged", embeddedChunks: 0 };
    }
    return client.update({
      repository,
      path,
      previousRevision: revision,
      revision: target,
      content,
    });
  });
  return {
    files: sources.length,
    updated: updates.filter((update) => update.state === "updated").length,
    embeddedChunks: updates.reduce((total, update) => total + update.embeddedChunks, 0),
  };
}
