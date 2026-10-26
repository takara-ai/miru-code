export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError;

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export class StdioTransport {
  private buffer = "";
  private started = false;
  private closed = false;
  private reader: Pick<ReadableStreamDefaultReader, "cancel" | "releaseLock"> | null = null;
  private abortController: AbortController | null = null;
  private readonly inputStream: () => ReadableStream<Uint8Array<ArrayBufferLike>>;
  private readonly writeText: (text: string) => Promise<unknown>;

  constructor(
    options: {
      inputStream?: () => ReadableStream<Uint8Array<ArrayBufferLike>>;
      writeText?: (text: string) => Promise<unknown>;
      stdin?: { stream: () => ReadableStream<Uint8Array<ArrayBufferLike>> };
      bunWrite?: (destination: typeof Bun.stdout, text: string) => Promise<unknown>;
    } = {},
  ) {
    this.inputStream = options.inputStream ?? (() => (options.stdin ?? Bun.stdin).stream());
    this.writeText =
      options.writeText ?? ((text) => (options.bunWrite ?? Bun.write)(Bun.stdout, text));
  }

  onmessage?: (message: JsonRpcMessage) => void | Promise<void>;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("StdioTransport already started");
    }
    if (this.closed) throw new Error("StdioTransport already closed");
    this.started = true;
    this.abortController = new AbortController();
    const decoder = new TextDecoder();

    try {
      const reader = this.inputStream().getReader();
      this.reader = reader;
      while (!this.abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await this.append(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      this.buffer = "";
      this.notifyClose();
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.buffer = "";
    try {
      await this.reader?.cancel();
    } finally {
      this.notifyClose();
    }
  }

  private notifyClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await this.writeText(line);
  }

  private async append(chunk: string): Promise<void> {
    this.buffer += chunk;
    while (!this.closed && !this.abortController?.signal.aborted) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        await Promise.resolve(this.onmessage?.(message));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
