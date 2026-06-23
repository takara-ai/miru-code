import type { JsonRpcMessage } from "../../src/mcp/stdio.ts";
import { StdioTransport } from "../../src/mcp/stdio.ts";

export class MemoryTransport extends StdioTransport {
  readonly sent: JsonRpcMessage[] = [];
  private readonly inbound: JsonRpcMessage[];

  constructor(messages: JsonRpcMessage[]) {
    super();
    this.inbound = messages;
  }

  override async start(): Promise<void> {
    for (const message of this.inbound) {
      await Promise.resolve(this.onmessage?.(message));
    }
    this.onclose?.();
  }

  override async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
  }

  responseFor(id: string | number): JsonRpcMessage | undefined {
    return this.sent.find((message) => "id" in message && message.id === id);
  }
}
