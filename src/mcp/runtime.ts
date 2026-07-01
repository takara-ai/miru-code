import * as z from "zod";
import { HIT_LINE_TOOLS, normalizeHitLineArgs } from "./hit-line.ts";
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

type RegisteredTool = {
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: ToolHandler<Record<string, unknown>>;
};

export type MiruMcpServerInfo = {
  name: string;
  version: string;
};

export class MiruMcpServer {
  readonly serverInfo: MiruMcpServerInfo;
  private readonly instructions?: string;
  private readonly tools = new Map<string, RegisteredTool>();
  private transport: StdioTransport | null = null;

  constructor(serverInfo: MiruMcpServerInfo, options?: { instructions?: string }) {
    this.serverInfo = serverInfo;
    this.instructions = options?.instructions;
  }

  registerTool<S extends Record<string, z.ZodType>>(
    name: string,
    config: {
      description: string;
      inputSchema: S;
    },
    handler: ToolHandler<z.infer<z.ZodObject<S>>>,
  ): void {
    this.tools.set(name, {
      description: config.description,
      inputSchema: config.inputSchema,
      handler: handler as ToolHandler<Record<string, unknown>>,
    });
  }

  async connect(transport: StdioTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = async (message) => {
      await this.handleMessage(message);
    };
    transport.onerror = (error) => {
      console.error(error);
    };
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
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
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: this.getCapabilities(),
      serverInfo: this.serverInfo,
      ...(this.instructions ? { instructions: this.instructions } : {}),
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
      description: tool.description,
      inputSchema: shapeToJsonSchema(tool.inputSchema),
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

    let args = input.data.arguments ?? {};
    if (HIT_LINE_TOOLS.has(input.data.name)) {
      args = normalizeHitLineArgs(args);
    }
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

function shapeToJsonSchema(shape: Record<string, z.ZodType>): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  const { $schema: _schema, ...rest } = schema;
  return rest;
}
