import { timingSafeEqual } from "node:crypto";
import * as z from "zod";
import {
  changeSchema,
  type Identity,
  identitySchema,
  querySchema,
  revisionSchema,
  SharedIndexError,
} from "./protocol.ts";
import { databaseErrorCode, type SharedIndex } from "./store.ts";

const MAX_BODY_BYTES = 800_000;
const errorResponse = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function handleSharedIndexRequest(
  request: Request,
  identity: Identity | undefined,
  index: SharedIndex,
): Promise<Response> {
  if (!identity) return errorResponse(403, "Shared index access denied.");
  if (request.method !== "POST") return errorResponse(405, "Use POST.");
  try {
    const reader = request.body?.getReader();
    let body: unknown;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new SharedIndexError(413, "Request is too large.");
          }
          chunks.push(value);
        }
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof SharedIndexError) throw error;
      throw new SharedIndexError(400, "Expected a JSON request.");
    }
    let result: unknown;
    switch (new URL(request.url).pathname) {
      case "/v1/search":
        result = await index.search(identity, querySchema.parse(body));
        break;
      case "/v1/file": {
        result = await index.update(identity, changeSchema.parse(body));
        break;
      }
      case "/v1/revision": {
        const { repository, path } = revisionSchema.parse(body);
        result = await index.revision(identity, repository, path);
        break;
      }
      default:
        return errorResponse(404, "Unknown shared index operation.");
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(400, "Invalid shared index request.");
    if (error instanceof SharedIndexError) return errorResponse(error.status, error.message);
    const code = databaseErrorCode(error);
    console.error("Shared index operation failed", code ?? (error as Error)?.name ?? "unknown");
    return errorResponse(code === "40001" ? 503 : 500, "Shared index operation failed.");
  }
}

export function iamIdentities(
  config: string,
): (requestArn: string | undefined) => Identity | undefined {
  const identities = z
    .record(z.string().startsWith("arn:"), identitySchema)
    .parse(JSON.parse(config));
  return (requestArn) =>
    requestArn && Object.hasOwn(identities, requestArn) ? identities[requestArn] : undefined;
}

/** Local demo credentials stay on loopback. Production takes identities from API Gateway IAM. */
export function loopbackIdentities(
  config: string,
): (authorization: string | null) => Identity | undefined {
  const identities = Object.entries(
    z.record(z.string().min(24), identitySchema).parse(JSON.parse(config)),
  );
  return (authorization) => {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const presented = Buffer.from(authorization.slice(7));
    return identities.find(([token]) => {
      const expected = Buffer.from(token);
      return expected.length === presented.length && timingSafeEqual(expected, presented);
    })?.[1];
  };
}
