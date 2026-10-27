import * as z from "zod";
import {
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  type StdioTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./stdio.ts";

const JSONRPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type ToolHandler<Args> = (args: Args) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

type ClientText = string | (() => string);

type RegisteredTool = {
  description: ClientText;
  meta?: Record<string, unknown>;
  inputSchema: Record<string, z.ZodType>;
  handler: ToolHandler<Record<string, unknown>>;
};

export type MiruMcpServerInfo = {
  name: string;
  version: string;
};

export class MiruMcpServer {
  readonly serverInfo: MiruMcpServerInfo;
  private readonly instructions?: ClientText;
  private client?: { name: string; version: string };
  private readonly tools = new Map<string, RegisteredTool>();
  private transport: StdioTransport | null = null;
  private readonly onclose?: () => void;

  constructor(
    serverInfo: MiruMcpServerInfo,
    options?: { instructions?: ClientText; onclose?: () => void },
  ) {
    this.serverInfo = serverInfo;
    this.instructions = options?.instructions;
    this.onclose = options?.onclose;
  }

  get clientInfo(): Readonly<{ name: string; version: string }> | undefined {
    return this.client;
  }

  registerTool<S extends Record<string, z.ZodType>>(
    name: string,
    config: {
      description: ClientText;
      inputSchema: S;
      _meta?: Record<string, unknown>;
    },
    handler: ToolHandler<z.infer<z.ZodObject<S>>>,
  ): void {
    this.tools.set(name, {
      description: config.description,
      meta: config._meta,
      inputSchema: config.inputSchema,
      handler: handler as ToolHandler<Record<string, unknown>>,
    });
  }

  async connect(transport: StdioTransport): Promise<void> {
    if (this.transport) throw new Error("MCP server already connected");
    this.transport = transport;
    const previousClose = transport.onclose;
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      if (this.transport === transport) this.transport = null;
      transport.onmessage = undefined;
      transport.onclose = undefined;
      try {
        this.onclose?.();
      } finally {
        previousClose?.();
      }
    };
    transport.onclose = release;
    transport.onmessage = async (message) => {
      await this.handleMessage(message);
    };
    transport.onerror = (error) => {
      console.error(error);
    };
    try {
      await transport.start();
    } catch (error) {
      release();
      throw error;
    }
  }

  async close(): Promise<void> {
    const transport = this.transport;
    try {
      await transport?.close();
    } finally {
      transport?.onclose?.();
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (!isRequest(message)) {
      if (isNotification(message)) {
        if (message.method === "notifications/initialized") {
          return;
        }
      }
      return;
    }

    try {
      const result = await this.dispatchRequest(message);
      if (result !== undefined) {
        await this.send({
          jsonrpc: "2.0",
          id: message.id,
          result,
        });
      }
    } catch (error) {
      await this.sendError(message.id, error);
    }
  }

  private async dispatchRequest(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return this.handleInitialize(request.params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.listTools() };
      case "tools/call":
        return await this.handleToolCall(request.params);
      default:
        throw rpcError(JSONRPC_ERROR.methodNotFound, `Method not found: ${request.method}`);
    }
  }

  private handleInitialize(params: unknown): Record<string, unknown> {
    const input = z
      .object({
        protocolVersion: z.string(),
        capabilities: z.record(z.string(), z.unknown()).optional(),
        clientInfo: z
          .object({
            name: z.string(),
            version: z.string(),
          })
          .optional(),
      })
      .safeParse(params);

    if (!input.success) {
      throw rpcError(JSONRPC_ERROR.invalidParams, "Invalid initialize params");
    }

    const requestedVersion = input.data.protocolVersion;
    this.client = input.data.clientInfo;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;

    const instructions =
      typeof this.instructions === "function" ? this.instructions() : this.instructions;
    return {
      protocolVersion,
      capabilities: this.getCapabilities(),
      serverInfo: this.serverInfo,
      ...(instructions ? { instructions } : {}),
    };
  }

  private getCapabilities(): Record<string, unknown> {
    if (this.tools.size === 0) {
      return {};
    }
    return {
      tools: {
        listChanged: true,
      },
    };
  }

  private listTools(): Array<Record<string, unknown>> {
    return [...this.tools.entries()].map(([name, tool]) => ({
      name,
      description: typeof tool.description === "function" ? tool.description() : tool.description,
      inputSchema: shapeToJsonSchema(tool.inputSchema),
      ...(tool.meta ? { _meta: tool.meta } : {}),
    }));
  }

  private async handleToolCall(params: unknown): Promise<Record<string, unknown>> {
    const input = z
      .object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(params);

    if (!input.success) {
      throw rpcError(JSONRPC_ERROR.invalidParams, "Invalid tools/call params");
    }

    const tool = this.tools.get(input.data.name);
    if (!tool) {
      throw rpcError(JSONRPC_ERROR.invalidParams, `Tool ${input.data.name} not found`);
    }

    const args = input.data.arguments ?? {};
    const parsed = z.object(tool.inputSchema).safeParse(args);
    if (!parsed.success) {
      throw rpcError(JSONRPC_ERROR.invalidParams, parsed.error.message);
    }

    return await tool.handler(parsed.data);
  }

  private async send(message: JsonRpcResponse): Promise<void> {
    await this.transport?.send(message);
  }

  private async sendError(id: JsonRpcId, error: unknown): Promise<void> {
    const rpc = error instanceof RpcError ? error : rpcError(JSONRPC_ERROR.internal, String(error));
    const message: JsonRpcError = {
      jsonrpc: "2.0",
      id,
      error: {
        code: rpc.code,
        message: rpc.message,
        ...(rpc.data !== undefined ? { data: rpc.data } : {}),
      },
    };
    await this.transport?.send(message);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return new RpcError(code, message, data);
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function isNotification(message: JsonRpcMessage): message is { jsonrpc: "2.0"; method: string } {
  return "method" in message && !("id" in message);
}

/**
 * Trim schema noise that costs tokens on every session but tells the model nothing: zod emits
 * Number.MAX_SAFE_INTEGER / MIN_SAFE_INTEGER bounds for every `.int()`, plus `minLength: 1` and
 * `minItems: 1` on non-empty strings and arrays. Validation still runs in zod at call time.
 */
function stripImplicitIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripImplicitIntegerBounds);
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(
          ([key, value]) =>
            !(key === "maximum" && value === Number.MAX_SAFE_INTEGER) &&
            !(key === "minimum" && value === Number.MIN_SAFE_INTEGER) &&
            !((key === "minLength" || key === "minItems") && value === 1),
        )
        .map(([key, value]) => [key, stripImplicitIntegerBounds(value)]),
    );
  }
  return node;
}

function shapeToJsonSchema(shape: Record<string, z.ZodType>): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  const { $schema: _schema, ...rest } = schema;
  return stripImplicitIntegerBounds(rest) as Record<string, unknown>;
}
