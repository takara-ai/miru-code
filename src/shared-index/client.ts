import { createHash, createHmac } from "node:crypto";
import type { FileChange, FileUpdate, SharedQuery, SharedResult } from "./protocol.ts";
import { SharedIndexError } from "./protocol.ts";

function bytes(data: string | ArrayBuffer | ArrayBufferView) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

class Sha256 {
  private engine: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;

  constructor(private readonly secret?: string | ArrayBuffer | ArrayBufferView) {
    this.engine = this.create();
  }

  private create() {
    return this.secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", bytes(this.secret));
  }

  update(data: string | ArrayBuffer | ArrayBufferView) {
    this.engine.update(bytes(data));
  }

  async digest() {
    return this.engine.digest();
  }

  reset() {
    this.engine = this.create();
  }
}

export async function awsSignedHeaders(
  url: URL,
  headers: Record<string, string>,
  body: string,
  service: string,
  region: string,
) {
  const [{ defaultProvider }, { SignatureV4 }] = await Promise.all([
    import("@aws-sdk/credential-provider-node"),
    import("@smithy/signature-v4"),
  ]);
  const signer = new SignatureV4({
    service,
    region,
    sha256: Sha256,
    credentials: defaultProvider(),
  });
  const signed = await signer.sign({
    method: "POST",
    hostname: url.hostname,
    protocol: url.protocol,
    path: url.pathname,
    headers: { ...headers, host: url.host },
    body,
  });
  return signed.headers;
}

export class SharedIndexClient {
  private readonly endpoint: URL;
  private readonly token?: string;
  private readonly region: string;

  constructor(endpoint: string, options: { token?: string; region?: string }) {
    this.endpoint = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname);
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      (options.token
        ? !loopback || this.endpoint.protocol !== "http:"
        : this.endpoint.protocol !== "https:")
    ) {
      throw new Error("Use HTTPS with AWS IAM, or HTTP on loopback for the shared index demo.");
    }
    this.token = options.token;
    this.region = options.region ?? "";
    if (!this.token && !this.region)
      throw new Error("Set MIRU_SHARED_REGION or AWS_REGION for IAM.");
  }

  static fromEnvironment(): SharedIndexClient | undefined {
    const endpoint = process.env.MIRU_SHARED_URL;
    if (!endpoint) return undefined;
    return new SharedIndexClient(endpoint, {
      token: process.env.MIRU_SHARED_LOCAL_TOKEN,
      region:
        process.env.MIRU_SHARED_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    });
  }

  private async request<T>(path: string, payload: unknown): Promise<T> {
    const url = new URL(`v1/${path}`, this.endpoint);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorized = this.token
      ? { ...headers, authorization: `Bearer ${this.token}` }
      : await awsSignedHeaders(url, headers, body, "execute-api", this.region);
    const response = await fetch(url, {
      method: "POST",
      headers: authorized,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = (result as { error?: unknown } | undefined)?.error;
      throw new SharedIndexError(
        response.status,
        typeof message === "string" ? message : `Shared index request failed (${response.status}).`,
      );
    }
    return result as T;
  }

  search(query: SharedQuery) {
    return this.request<SharedResult[]>("search", query);
  }

  update(change: FileChange) {
    return this.request<FileUpdate>("file", change);
  }

  revision(repository: string, path: string) {
    return this.request<{ revision: string | null }>("revision", { repository, path });
  }
}
