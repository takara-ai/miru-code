import { describe, expect, test } from "bun:test";
import { type JsonRpcMessage, StdioTransport } from "../src/mcp/stdio.ts";

describe("StdioTransport", () => {
  test("uses Bun stdin and stdout defaults when no streams are supplied", async () => {
    const writes: string[] = [];
    const transport = new StdioTransport({
      stdin: {
        stream: () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      },
      bunWrite: async (_destination, text) => writes.push(text),
    });
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(writes).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n']);
  });

  test("parses newline delimited messages, reports invalid JSON, and sends JSON", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '{"jsonrpc":"2.0","method":"ping"}\r\n\n{"bad"\n{"jsonrpc":"2.0","method":"throws"}\n',
          ),
        );
        controller.close();
      },
    });
    const sent: string[] = [];
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    let closes = 0;
    const transport = new StdioTransport({
      inputStream: () => input,
      writeText: async (text) => {
        sent.push(text);
      },
    });
    transport.onmessage = (message) => {
      messages.push(message);
      if ("method" in message && message.method === "throws") throw new Error("handler failed");
    };
    transport.onerror = (error) => {
      errors.push(error);
    };
    transport.onclose = () => {
      closes++;
    };

    await transport.start();
    expect(messages).toEqual([
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "throws" },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain("JSON");
    expect(errors[1]?.message).toBe("handler failed");
    expect(closes).toBe(1);
    await transport.send({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(sent).toEqual(['{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n']);
    await expect(transport.start()).rejects.toThrow("already started");
    await transport.close();
    expect(closes).toBe(2);
  });

  test("reports stream failures and releases the reader", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("input broke"));
      },
    });
    let received: Error | undefined;
    let closed = false;
    const transport = new StdioTransport({ inputStream: () => input });
    transport.onerror = (error) => {
      received = error;
    };
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();
    expect(received?.message).toBe("input broke");
    expect(closed).toBe(true);
  });
});
