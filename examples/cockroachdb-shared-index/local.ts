import {
  handleSharedIndexRequest,
  loopbackIdentities,
  MAX_BODY_BYTES,
} from "../../src/shared-index/router.ts";
import { openSharedIndex } from "../../src/shared-index/runtime.ts";

const identity = loopbackIdentities(process.env.MIRU_SHARED_LOCAL_IDENTITIES ?? "{}");
const index = openSharedIndex(process.env.MIRU_SHARED_DATABASE_URL ?? "", { local: true });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MIRU_SHARED_PORT ?? 8765),
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: (request) =>
    handleSharedIndexRequest(request, identity(request.headers.get("authorization")), index),
});
console.log(`Shared index listening at ${server.url}`);
