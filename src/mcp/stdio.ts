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
  private abortController: AbortController | null = null;

  onmessage?: (message: JsonRpcMessage) => void | Promise<void>;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("StdioTransport already started");
    }
    this.started = true;
    this.abortController = new AbortController();
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    // TEMPORARY: diagnosing a Windows-only cold-start test failure where the
    // child exits cleanly in <150ms with zero output — see
    // tests/cli-mcp-cold-start.test.ts and
    // github.com/takara-ai/miru-code/actions/runs/36162373907. Remove once
    // root-caused.
    const diag = process.env.MIRU_COLD_START_DIAG === "1";
    const mark = (label: string) => {
      if (diag) {
        process.stderr.write(`[stdio-diag] ${label} @ ${Date.now()}\n`);
      }
    };
    mark("start() entered, about to read stdin");

    try {
      while (!this.abortController.signal.aborted) {
        const { done, value } = await reader.read();
        mark(`stdin read() done=${done} bytes=${value?.length ?? 0}`);
        if (done) {
          break;
        }
        await this.append(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      mark(`caught error: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.abortController.signal.aborted) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      reader.releaseLock();
      this.onclose?.();
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.buffer = "";
    this.onclose?.();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await Bun.write(Bun.stdout, line);
  }

  private async append(chunk: string): Promise<void> {
    this.buffer += chunk;
    while (true) {
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
