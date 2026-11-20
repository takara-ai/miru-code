import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { SharedIndexClient } from "../src/shared-index/client.ts";
import { preparedChangeSchema, type SharedResult } from "../src/shared-index/protocol.ts";
import { handleSharedIndexRequest, iamIdentities } from "../src/shared-index/router.ts";
import { SharedIndex } from "../src/shared-index/store.ts";
import { tokenize } from "../src/tokens.ts";

const databaseUrl = process.env.MIRU_TEST_CRDB_URL;
const model = "fixture-ds1-256";
const writer = { tenant: randomUUID(), principal: "ci" };
const reader = { tenant: writer.tenant, principal: "developer" };
const guest = { tenant: randomUUID(), principal: reader.principal };
const allowed = "example/api";
const other = "example/worker";
const restricted = "example/private";
const filename = "src/auth.ts";
const token = "fixture-reader-credential-01";
const writeToken = "fixture-writer-credential-01";
const guestToken = "fixture-guest-credential-001";

function fixtureVector(text: string): Float32Array {
  const vector = new Float32Array(256);
  vector[0] = 1;
  for (const word of tokenize(text)) {
    vector[createHash("sha256").update(word).digest()[0] ?? 0] += 1;
  }
  return vector;
}

test("IAM lookup accepts only an exact, configured principal ARN", () => {
  const arn = "arn:aws:sts::123456789012:assumed-role/developers/alice";
  const identify = iamIdentities(JSON.stringify({ [arn]: reader }));
  expect(identify(arn)).toEqual(reader);
  expect(identify(arn.replace("alice", "bob"))).toBeUndefined();
  expect(identify("constructor")).toBeUndefined();
});

test("the shared client rejects malformed success responses", async () => {
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ state: "updated" }),
  });
  try {
    const client = new SharedIndexClient(gateway.url.href, { token });
    await expect(client.gitState(allowed)).rejects.toThrow(
      "Invalid response from the shared index",
    );
  } finally {
    await gateway.stop(true);
  }
});

test("Miru sends hashed chunks and reranks database candidates on the client", async () => {
  const content = "export function verifyOAuthToken() { return true; }";
  const observed: unknown[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      observed.push(await request.json());
      if (new URL(request.url).pathname === "/v1/file") {
        return Response.json({ state: "updated", embeddedChunks: 1 });
      }
      return Response.json({
        model,
        candidates: [
          {
            repository: allowed,
            file_path: filename,
            start_line: 1,
            end_line: 1,
            language: "typescript",
            similarity: 0.8,
            content,
          },
        ],
      });
    },
  });
  try {
    const client = new SharedIndexClient(gateway.url.href, { token });
    await client.update({
      repository: allowed,
      path: filename,
      previousRevision: null,
      revision: "v1",
      content,
    });
    const request = preparedChangeSchema.parse(observed[0]);
    const expectedHash = createHash("sha256").update(content).digest("hex");
    expect(request.fileHash).toBe(expectedHash);
    expect(request.chunks).toEqual([
      { start_line: 1, end_line: 1, language: "typescript", content, hash: expectedHash },
    ]);
    const hits = await client.search({ query: "OAuth token", repositories: [allowed] });
    expect(hits[0]).toMatchObject({
      repository: allowed,
      chunk: { file_path: filename },
      score: expect.any(Number),
    });
  } finally {
    await gateway.stop(true);
  }
});

let db: SQL | undefined;
let runtimeDb: SQL | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let ownerClient: SharedIndexClient;
let readerClient: SharedIndexClient;
let guestClient: SharedIndexClient;
let embedded = 0;
const backend: EmbeddingBackend = {
  model,
  dimensions: 256,
  embedQuery: async (query) => fixtureVector(query),
  embedDocuments: async (chunks) => {
    embedded += chunks.length;
    return chunks.map(fixtureVector);
  },
};

beforeAll(async () => {
  if (!databaseUrl) return;
  db = new SQL(databaseUrl);
  for (const repository of [allowed, other, restricted]) {
    await db`INSERT INTO miru_repositories (tenant_id, repository_id, model_key) VALUES (${writer.tenant}, ${repository}, ${model})`;
    await db`INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write) VALUES (${writer.tenant}, ${repository}, ${writer.principal}, true)`;
  }
  for (const repository of [allowed, other]) {
    await db`INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write) VALUES (${reader.tenant}, ${repository}, ${reader.principal}, false)`;
  }
  await db`INSERT INTO miru_repositories (tenant_id, repository_id, model_key) VALUES (${guest.tenant}, ${allowed}, ${model})`;
  await db`INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write) VALUES (${guest.tenant}, ${allowed}, ${guest.principal}, true)`;
  runtimeDb = process.env.MIRU_TEST_CRDB_ROUTER_URL
    ? new SQL(process.env.MIRU_TEST_CRDB_ROUTER_URL)
    : db;
  const index = new SharedIndex(runtimeDb, backend, model);
  const identities = new Map([
    [`Bearer ${token}`, reader],
    [`Bearer ${writeToken}`, writer],
    [`Bearer ${guestToken}`, guest],
  ]);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      handleSharedIndexRequest(
        request,
        identities.get(request.headers.get("authorization") ?? ""),
        index,
      ),
  });
  ownerClient = new SharedIndexClient(server.url.href, { token: writeToken });
  readerClient = new SharedIndexClient(server.url.href, { token });
  guestClient = new SharedIndexClient(server.url.href, { token: guestToken });
});

afterAll(async () => {
  await server?.stop(true);
  if (!db) return;
  const tenants = `${writer.tenant},${guest.tenant}`;
  await db`DELETE FROM miru_chunks WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  await db`DELETE FROM miru_embeddings WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  await db`DELETE FROM miru_files WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  await db`DELETE FROM miru_git_sync WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  await db`DELETE FROM miru_repository_grants WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  await db`DELETE FROM miru_repositories WHERE tenant_id = ANY(string_to_array(${tenants}, ','))`;
  if (runtimeDb !== db) await runtimeDb?.close();
  await db.close();
});

test.skipIf(!databaseUrl)(
  "shares repository search, rejects stale writes, and enforces grants",
  async () => {
    const source = "export function verifyOAuthToken(token: string) { return token.length > 8; }";
    const write = { repository: allowed, path: filename, content: source };
    expect(
      await ownerClient.update({ ...write, previousRevision: null, revision: "first" }),
    ).toEqual({
      state: "updated",
      embeddedChunks: 1,
    });
    await ownerClient.update({
      ...write,
      repository: other,
      previousRevision: null,
      revision: "one",
      content: "export function queueTokenAudit(token: string) { return { token }; }",
    });
    await ownerClient.update({
      ...write,
      repository: restricted,
      previousRevision: null,
      revision: "one",
      content: "export function verifyOAuthToken() { return 'restricted fixture'; }",
    });
    await guestClient.update({
      ...write,
      previousRevision: null,
      revision: "guest",
      content: "export function verifyOAuthToken() { return 'other tenant fixture'; }",
    });
    const query = { query: "verify OAuth token", repositories: [restricted, other, allowed] };
    const hits = await readerClient.search(query);
    expect(hits.map((hit) => hit.repository)).toEqual([allowed, other]);
    expect(hits[0]?.chunk.content).toContain("verifyOAuthToken");
    expect(hits.every((hit) => !hit.chunk.content.includes("other tenant fixture"))).toBe(true);
    expect((await guestClient.search(query)).map((hit) => hit.chunk.content)).toEqual([
      "export function verifyOAuthToken() { return 'other tenant fixture'; }",
    ]);
    expect(await readerClient.search({ ...query, repositories: [restricted] })).toEqual([]);
    await expect(
      readerClient.update({ ...write, previousRevision: "first", revision: "second" }),
    ).rejects.toThrow("Writable repository not found");

    const beforeNoChange = embedded;
    expect(
      await ownerClient.update({ ...write, previousRevision: null, revision: "first" }),
    ).toEqual({
      state: "unchanged",
      embeddedChunks: 0,
    });
    expect(
      await ownerClient.update({ ...write, previousRevision: "first", revision: "second" }),
    ).toEqual({
      state: "updated",
      embeddedChunks: 0,
    });
    expect(
      await ownerClient.update({
        ...write,
        path: "src/copy.ts",
        previousRevision: null,
        revision: "copy",
      }),
    ).toEqual({ state: "updated", embeddedChunks: 0 });
    expect(embedded).toBe(beforeNoChange);

    const contenders = await Promise.allSettled(
      ["winner-a", "winner-b"].map((revision) =>
        ownerClient.update({
          ...write,
          revision,
          previousRevision: "second",
          content: `export const value = "${revision}";`,
        }),
      ),
    );
    expect(contenders.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const loser = contenders.find(({ status }) => status === "rejected");
    expect(loser?.status === "rejected" && loser.reason.status).toBe(409);

    const current = await ownerClient.revision(allowed, filename);
    expect(current.revision).toMatch(/^winner-[ab]$/);
    await ownerClient.update({
      ...write,
      previousRevision: current.revision,
      revision: "deleted",
      content: null,
    });
    await expect(
      ownerClient.update({ ...write, previousRevision: null, revision: "stale" }),
    ).rejects.toThrow("file revision changed");
    const remaining = await readerClient.search(query);
    expect(
      remaining.every((hit) => hit.repository !== allowed || hit.chunk.file_path !== filename),
    ).toBe(true);
    if (!db) throw new Error("Database not configured.");
    await db`UPDATE miru_repository_grants SET expires_at = now() - INTERVAL '1 minute'
      WHERE tenant_id = ${reader.tenant} AND principal_id = ${reader.principal}`;
    expect(await readerClient.search(query)).toEqual([]);
  },
  15_000,
);

test.skipIf(!databaseUrl)(
  "repository filtering retains the C-SPANN query plan",
  async () => {
    if (!db || !runtimeDb) throw new Error("Database not configured.");
    const repository = "example/vector-plan";
    const vector = `[1,${Array<string>(255).fill("0").join(",")}]`;
    await db`INSERT INTO miru_repositories (tenant_id, repository_id, model_key)
    VALUES (${reader.tenant}, ${repository}, ${model})`;
    await db`INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write)
    VALUES (${reader.tenant}, ${repository}, ${reader.principal}, false)`;
    await db`INSERT INTO miru_files (tenant_id, repository_id, file_path, revision, content_hash)
    SELECT ${reader.tenant}, ${repository}, 'src/file-' || id || '.ts', 'v1', 'fixture'
    FROM generate_series(1, 4) AS series(id)`;
    await db`INSERT INTO miru_chunks
    SELECT tenant_id, repository_id, file_path, 0, 1, 1, 'typescript', 'export const demo = true;',
      to_tsvector('simple', 'demo'), ${vector}::VECTOR
    FROM miru_files WHERE tenant_id = ${reader.tenant} AND repository_id = ${repository}`;
    const plan = await runtimeDb<{ info: string }[]>`
    EXPLAIN SELECT repository_id AS repository, file_path, start_line, end_line, language, content,
      1 - (embedding <=> ${vector}::VECTOR) AS similarity
    FROM miru_chunks@{FORCE_INDEX=miru_vector_idx}
    WHERE tenant_id = ${reader.tenant} AND repository_id = ${repository} AND EXISTS (
      SELECT 1 FROM miru_repository_grants
      WHERE tenant_id = ${reader.tenant} AND repository_id = ${repository} AND principal_id = ${reader.principal}
        AND (expires_at IS NULL OR expires_at > now())
    )
    ORDER BY embedding <=> ${vector}::VECTOR LIMIT 32
  `;
    expect(plan.map((row) => row.info).join("\n")).toContain("miru_vector_idx");
  },
  30_000,
);

test.skipIf(!databaseUrl)(
  "uses the CLI for Git ingestion and the stdio MCP tool for headless search",
  async () => {
    if (!server || !db) throw new Error("Database and test router are required.");
    const repository = "example/headless";
    await db`INSERT INTO miru_repositories (tenant_id, repository_id, model_key)
    VALUES (${writer.tenant}, ${repository}, ${model})`;
    for (const actor of [writer, reader]) {
      await db`INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write)
      VALUES (${actor.tenant}, ${repository}, ${actor.principal}, ${actor === writer})`;
    }
    const mirror = await mkdtemp(join(tmpdir(), "miru-shared-git-"));
    const headless = await mkdtemp(join(tmpdir(), "miru-shared-headless-"));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const env = { ...process.env, MIRU_NO_UPDATE_CHECK: "1", MIRU_SHARED_URL: server.url.href };
    async function run(args: string[], cwd = mirror, stdin?: string, auth = writeToken) {
      const child = Bun.spawn(args, {
        cwd,
        env: { ...env, MIRU_SHARED_LOCAL_TOKEN: auth },
        stdout: "pipe",
        stderr: "pipe",
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      });
      const [out, err, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(err || out || `Process exited ${status}`);
      return out.trim();
    }
    try {
      await run(["git", "init", "-q"]);
      await run(["git", "config", "user.name", "Miru fixture"]);
      await run(["git", "config", "user.email", "miru@example.invalid"]);
      await Bun.write(join(mirror, "policy.ts"), "export const enforceRateLimit = () => 42;\n");
      await run(["git", "add", "--", "policy.ts"]);
      await run(["git", "commit", "-qm", "add fixture"]);
      const first = await run(["git", "rev-parse", "HEAD"]);
      expect(
        JSON.parse(await run([process.execPath, cli, "shared", "sync-git", repository, first])),
      ).toEqual({ files: 1, updated: 1, embeddedChunks: 1 });

      const request = `${[
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-fixture", version: "1.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_shared",
            arguments: { query: "enforce rate limit", repositories: [repository] },
          },
        },
      ]
        .map((rpc) => JSON.stringify(rpc))
        .join("\n")}\n`;
      const stdio = await run([process.execPath, cli, "mcp"], headless, request, token);
      const reply = stdio
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((item) => item.id === 2);
      const results = JSON.parse(reply?.result?.content[0]?.text ?? "[]") as SharedResult[];
      expect(results[0]).toMatchObject({
        repository,
        chunk: { file_path: "policy.ts", start_line: 1 },
      });
      expect(results[0]?.chunk.content).toContain("enforceRateLimit");

      expect(await ownerClient.gitState(repository)).toEqual({ completed: first, active: null });
      expect(
        JSON.parse(await run([process.execPath, cli, "shared", "sync-git", repository, first])),
      ).toEqual({ files: 0, updated: 0, embeddedChunks: 0 });

      await run(["git", "rm", "-q", "--", "policy.ts"]);
      await run(["git", "commit", "-qm", "delete fixture"]);
      const second = await run(["git", "rev-parse", "HEAD"]);
      await expect(readerClient.gitState(repository)).rejects.toThrow(
        "Writable repository not found",
      );
      // Simulate a CI job that was interrupted after publishing its first file.
      await ownerClient.gitSync({ action: "begin", repository, base: first, target: second });
      await ownerClient.update({
        repository,
        path: "policy.ts",
        previousRevision: first,
        revision: second,
        content: null,
        gitSync: true,
      });
      await Bun.write(join(mirror, "final.ts"), "export const newRateLimit = () => 43;\n");
      await run(["git", "add", "final.ts"]);
      await run(["git", "commit", "-qm", "add final fixture"]);
      const third = await run(["git", "rev-parse", "HEAD"]);
      await expect(
        run([process.execPath, cli, "shared", "sync-git", repository, third]),
      ).rejects.toThrow("Resume the incomplete sync");
      expect(
        JSON.parse(
          await run([process.execPath, cli, "shared", "sync-git", repository, second, first]),
        ),
      ).toEqual({ files: 1, updated: 0, embeddedChunks: 0 });
      expect(
        await readerClient.search({ query: "rate limit", repositories: [repository] }),
      ).toEqual([]);
      expect(
        JSON.parse(await run([process.execPath, cli, "shared", "sync-git", repository, third])),
      ).toEqual({ files: 1, updated: 1, embeddedChunks: 1 });
      await expect(
        run([process.execPath, cli, "shared", "sync-git", repository, first]),
      ).rejects.toThrow("must be an ancestor");
      await expect(
        ownerClient.update({
          repository,
          path: "policy.ts",
          previousRevision: second,
          revision: second,
          content: "stale file",
          gitSync: true,
        }),
      ).rejects.toThrow("not the active Git sync");
      await Bun.write(join(mirror, "final.ts"), " ".repeat(128_001));
      await run(["git", "add", "final.ts"]);
      await run(["git", "commit", "-qm", "oversize fixture"]);
      const fourth = await run(["git", "rev-parse", "HEAD"]);
      expect(
        JSON.parse(await run([process.execPath, cli, "shared", "sync-git", repository, fourth])),
      ).toEqual({ files: 1, updated: 1, embeddedChunks: 0 });
      expect(
        await readerClient.search({ query: "rate limit", repositories: [repository] }),
      ).toEqual([]);
    } finally {
      await rm(mirror, { recursive: true, force: true });
      await rm(headless, { recursive: true, force: true });
    }
  },
  20_000,
);
