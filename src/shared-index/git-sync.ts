import { extname } from "node:path";
import { mapPool } from "../concurrency.ts";
import { getExtensions } from "../index/files.ts";
import { defaultContentTypes } from "../types.ts";
import type { SharedIndexClient } from "./client.ts";
import { gitCommitId, revisionSchema, SharedIndexError } from "./protocol.ts";

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

export async function syncGit(
  client: SharedIndexClient,
  repository: string,
  target: string,
  base?: string,
) {
  if ((await readGit(["rev-parse", "--show-prefix"])).trim()) {
    throw new Error("Run sync-git from the repository root.");
  }
  if (![target, ...(base ? [base] : [])].every((sha) => gitCommitId.safeParse(sha).success)) {
    throw new Error("Pass full Git commit object IDs for the target and optional base.");
  }
  if ((await readGit(["cat-file", "-t", target])).trim() !== "commit") {
    throw new Error("The target must be a Git commit.");
  }
  const state = await client.gitState(repository);
  if (!state.active && state.completed === target) {
    return { files: 0, updated: 0, embeddedChunks: 0 };
  }
  if (state.active && state.active !== target) {
    throw new Error(
      `Resume the incomplete sync of ${state.active} before indexing another commit.`,
    );
  }
  if (base && base !== state.completed)
    throw new Error("The requested base is not the last indexed commit.");
  const previous = state.completed;
  if (previous && (await git(["merge-base", "--is-ancestor", previous, target])).status !== 0) {
    throw new Error(
      "The last indexed commit must be an ancestor of the target. Fetch the complete canonical history.",
    );
  }

  // A path can look unchanged between the last completed and target commits
  // only after the current batch completes; a partial batch resumes that exact target.
  const sync = { repository, base: previous, target };

  const paths = previous
    ? await readGit(["diff", "--no-renames", "--name-only", "-z", previous, target, "--"])
    : await readGit(["ls-tree", "-rz", "--name-only", target, "--"]);
  const extensions = new Set(getExtensions(defaultContentTypes()));
  const sources = paths
    .split("\0")
    .filter(
      (path) =>
        extensions.has(extname(path).toLowerCase()) ||
        path.split("/").at(-1)?.toLowerCase() === "dockerfile",
    );
  for (const path of sources) revisionSchema.parse({ repository, path });
  const started = await client.gitSync({ ...sync, action: "begin" });
  if (started.completed === target) return { files: 0, updated: 0, embeddedChunks: 0 };

  const updates = await mapPool(sources, 3, async (path) => {
    const { revision } = await client.revision(repository, path);
    if (revision === target) return { state: "unchanged", embeddedChunks: 0 };

    const entry = await readGit(["--literal-pathspecs", "ls-tree", "-z", target, "--", path]);
    const blobMatch = /^(?:100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
    let content: string | null = null;
    if (blobMatch?.[1]) {
      const blob = blobMatch[1];
      const size = Number(await readGit(["cat-file", "-s", blob]));
      if (size <= 128_000) {
        const { bytes, status, error } = await git(["cat-file", "blob", blob]);
        if (status !== 0) throw new Error(error.trim() || "Could not read the Git blob.");
        const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
        if (!text.includes("\0") && Buffer.from(text).equals(Buffer.from(bytes))) content = text;
      }
    }
    if (content === null && !revision) {
      return { state: "unchanged", embeddedChunks: 0 };
    }
    try {
      return await client.update({
        repository,
        path,
        previousRevision: revision,
        revision: target,
        content,
        gitSync: true,
      });
    } catch (error) {
      if (
        error instanceof SharedIndexError &&
        error.status === 409 &&
        (await client.gitState(repository)).completed === target
      ) {
        return { state: "unchanged", embeddedChunks: 0 };
      }
      throw error;
    }
  });
  await client.gitSync({ ...sync, action: "finish" });
  return {
    files: sources.length,
    updated: updates.filter((update) => update.state === "updated").length,
    embeddedChunks: updates.reduce((total, update) => total + update.embeddedChunks, 0),
  };
}
