import { UsageError } from "../cli-args.ts";
import { SharedIndexClient } from "./client.ts";
import { syncGit } from "./git-sync.ts";
import { changeSchema, querySchema, repositoryId, revisionSchema } from "./protocol.ts";

export async function runSharedIndexCli(args: string[]) {
  const [action, ...params] = args;
  const client = SharedIndexClient.fromEnvironment();
  if (!client) throw new UsageError("Set MIRU_SHARED_URL for the shared index.", "shared");

  if (action === "sync-git" && (params.length === 2 || params.length === 3) && params[1]) {
    console.log(
      JSON.stringify(await syncGit(client, repositoryId.parse(params[0]), params[1], params[2])),
    );
    return;
  }
  if (action === "search") {
    const [query, ...repositories] = params;
    console.log(
      JSON.stringify(await client.search(querySchema.parse({ query, repositories })), null, 2),
    );
    return;
  }
  if (action === "revision" && params.length === 2) {
    const { repository, path } = revisionSchema.parse({ repository: params[0], path: params[1] });
    console.log(JSON.stringify(await client.revision(repository, path)));
    return;
  }
  if ((action === "put" && params.length === 5) || (action === "delete" && params.length === 4)) {
    const [repository, path, previous, revision, source] = params;
    const file = source ? Bun.file(source) : undefined;
    if (file && (await file.stat()).size > 128_000)
      throw new UsageError("Source file exceeds 128 KB.");
    const change = changeSchema.parse({
      repository,
      path,
      previousRevision: previous === "-" ? null : previous,
      revision,
      content: file ? await file.text() : null,
    });
    console.log(JSON.stringify(await client.update(change)));
    return;
  }
  throw new UsageError("Expected search, sync-git, revision, put or delete.", "shared");
}
