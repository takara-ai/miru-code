import * as z from "zod";
import { identitySchema, repositoryId } from "../../src/shared-index/protocol.ts";
import { connectSharedDatabase } from "../../src/shared-index/runtime.ts";

const [tenantArg, repositoryArg, principalFile] = process.argv.slice(2);
const tenant = identitySchema.shape.tenant.parse(tenantArg);
const repository = repositoryId.refine((id) => id.split("/").length === 2).parse(repositoryArg);
if (!principalFile)
  throw new Error("Pass a file mapping GitHub numeric user IDs to Miru principal IDs.");
const principals = z
  .record(z.string().regex(/^[1-9]\d*$/), identitySchema.shape.principal)
  .parse(await Bun.file(principalFile).json());
if (new Set(Object.values(principals)).size !== Object.keys(principals).length) {
  throw new Error("Each GitHub user must map to a distinct principal.");
}
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("Set GITHUB_TOKEN for repository collaborator reads.");

const collaboratorPage = z.array(
  z.object({
    id: z.number().int().positive(),
    permissions: z.object({ pull: z.boolean() }),
  }),
);

const db = connectSharedDatabase(process.env.MIRU_SHARED_ACL_DATABASE_URL ?? "");
try {
  const [clock] = await db<{ timestamp: string }[]>`SELECT now()::STRING AS timestamp`;
  if (!clock) throw new Error("Could not read the database clock.");
  const eligible = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/collaborators?affiliation=all&per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub permission read failed (${response.status}).`);
    const collaborators = collaboratorPage.parse(await response.json());
    for (const collaborator of collaborators) {
      const principal = principals[String(collaborator.id)];
      if (collaborator.permissions.pull && principal) eligible.add(principal);
    }
    if (collaborators.length < 100) break;
  }

  const applied = await db.begin(async (tx) => {
    const [updated] = await tx`
      UPDATE miru_repositories SET github_acl_started_at = ${clock.timestamp}::TIMESTAMPTZ
      WHERE tenant_id = ${tenant} AND repository_id = ${repository}
        AND (github_acl_started_at IS NULL OR github_acl_started_at < ${clock.timestamp}::TIMESTAMPTZ)
      RETURNING repository_id
    `;
    if (!updated) return false;
    await tx`
      DELETE FROM miru_repository_grants
      WHERE tenant_id = ${tenant} AND repository_id = ${repository} AND managed_by_github
    `;
    for (const principal of eligible) {
      await tx`
        INSERT INTO miru_repository_grants
          (tenant_id, repository_id, principal_id, can_write, expires_at, managed_by_github)
        VALUES (${tenant}, ${repository}, ${principal}, false,
          ${clock.timestamp}::TIMESTAMPTZ + INTERVAL '15 minutes', true)
        ON CONFLICT DO NOTHING
      `;
    }
    return true;
  });
  console.log(JSON.stringify({ applied, readGrants: applied ? eligible.size : 0 }));
} finally {
  await db.close();
}
