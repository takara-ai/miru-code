import * as z from "zod";
import { awsSignedHeaders } from "../../src/shared-index/client.ts";
import { handleSharedIndexRequest, iamIdentities } from "../../src/shared-index/router.ts";
import { openSharedIndex } from "../../src/shared-index/runtime.ts";

const runtime = `http://${process.env.AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime`;
const identity = iamIdentities(process.env.MIRU_SHARED_IAM_IDENTITIES ?? "{}");
const eventSchema = z.object({
  pathParameters: z.object({
    operation: z.enum(["search", "file", "revision", "git-state", "git-sync"]),
  }),
  httpMethod: z.literal("POST"),
  requestContext: z.object({ identity: z.object({ userArn: z.string().nullish() }) }),
  body: z.string().nullish(),
  isBase64Encoded: z.boolean().optional(),
});

async function startIndex() {
  const secretArn = process.env.MIRU_SHARED_DATABASE_SECRET_ARN;
  const region = process.env.AWS_REGION;
  if (!secretArn || !region) throw new Error("Configure the database secret ARN and AWS region.");
  const url = new URL(`https://secretsmanager.${region}.amazonaws.com/`);
  const body = JSON.stringify({ SecretId: secretArn });
  const headers = await awsSignedHeaders(
    url,
    {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
    body,
    "secretsmanager",
    region,
  );
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The shared index database secret could not be loaded.");
  const { SecretString } = z.object({ SecretString: z.string() }).parse(await response.json());
  if (!SecretString.startsWith("{")) return openSharedIndex(SecretString);
  const database = z
    .strictObject({ url: z.string(), ca: z.string().min(1) })
    .parse(JSON.parse(SecretString));
  return openSharedIndex(database.url, { ca: database.ca });
}

let index: Awaited<ReturnType<typeof startIndex>> | undefined;
for (;;) {
  const next = await fetch(`${runtime}/invocation/next`, { decompress: false, timeout: false });
  const requestId = next.headers.get("lambda-runtime-aws-request-id");
  if (!next.ok || !requestId) throw new Error("Lambda Runtime API did not return an invocation.");
  try {
    const event = eventSchema.parse(await next.json());
    const actor = identity(event.requestContext.identity.userArn ?? undefined);
    let response: Response;
    if (!actor) {
      response = Response.json({ error: "Shared index access denied." }, { status: 403 });
    } else {
      index ??= await startIndex();
      const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : event.body;
      const request = new Request(
        `https://shared-index.invalid/v1/${event.pathParameters.operation}`,
        {
          method: event.httpMethod,
          body,
        },
      );
      response = await handleSharedIndexRequest(request, actor, index);
    }
    const reported = await fetch(`${runtime}/invocation/${requestId}/response`, {
      method: "POST",
      body: JSON.stringify({
        statusCode: response.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: await response.text(),
      }),
    });
    if (!reported.ok) throw new Error("Lambda Runtime API refused the response.");
  } catch (error) {
    console.error("Shared index invocation failed", (error as Error)?.name);
    const reported = await fetch(`${runtime}/invocation/${requestId}/error`, {
      method: "POST",
      body: JSON.stringify({
        errorMessage: "Shared index invocation failed.",
        errorType: "SharedIndexError",
      }),
    });
    if (!reported.ok) throw new Error("Lambda Runtime API refused the error response.");
  }
}
