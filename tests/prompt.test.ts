import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type * as readline from "node:readline/promises";
import {
  applyHiddenPromptChar,
  createHiddenPromptState,
  createPromptInterface,
  promptHidden,
  promptText,
  promptTextWith,
} from "../src/prompt.ts";

describe("applyHiddenPromptChar", () => {
  test("creates the default prompt interface with the supplied readline factory", () => {
    const options = { input: process.stdin, output: process.stdout };
    let received: unknown;
    const fake = { question: async () => "ok", close: () => {} };
    expect(
      createPromptInterface(options, (given) => {
        received = given;
        return fake as never;
      }),
    ).toBe(fake);
    expect(received).toBe(options);
  });

  test("appends printable characters", () => {
    const state = createHiddenPromptState();
    const a = applyHiddenPromptChar(state, "a");
    expect(a.echo).toBe("*");
    expect(a.state.value).toBe("a");
    const b = applyHiddenPromptChar(a.state, "b");
    expect(b.state.value).toBe("ab");
  });

  test("backspace removes last character", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "x").state;
    state = applyHiddenPromptChar(state, "y").state;
    const del = applyHiddenPromptChar(state, "\u007f");
    expect(del.state.value).toBe("x");
    expect(del.echo).toBe("\b \b");
  });

  test("backspace on empty input is a no-op", () => {
    const result = applyHiddenPromptChar(createHiddenPromptState(), "\b");
    expect(result.state.value).toBe("");
    expect(result.echo).toBe("");
  });

  test("submit on enter", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "k").state;
    const result = applyHiddenPromptChar(state, "\n");
    expect(result.submit).toBe(true);
    expect(result.state.value).toBe("k");
  });

  test("ignores escape sequences", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "k").state;
    for (const char of "\x1b[A") {
      state = applyHiddenPromptChar(state, char).state;
    }
    expect(state.value).toBe("k");
  });

  test("ignores incomplete escapes, controls, and empty delete; handles submit and cancel", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "\x1b").state;
    state = applyHiddenPromptChar(state, "[").state;
    expect(state.escapeBuffer).toBe("\x1b[");
    state = applyHiddenPromptChar(state, "A").state;
    expect(state.escapeBuffer).toBe("");
    expect(applyHiddenPromptChar(state, "\u0001").echo).toBe("");
    expect(applyHiddenPromptChar(state, "\x7f").echo).toBe("");
    expect(applyHiddenPromptChar(state, "\u0004").submit).toBe(true);
    expect(applyHiddenPromptChar(state, "\u0003").cancel).toBe(true);
    expect(applyHiddenPromptChar(state, "\r").submit).toBe(true);
    state = applyHiddenPromptChar(state, "\x1b").state;
    expect(applyHiddenPromptChar(state, "x").state.escapeBuffer).toBe("");
  });

  test("visible prompt trims answers, uses the default, and closes the interface", async () => {
    const calls: string[] = [];
    const createInterface = (() => ({
      question: async (question: string) => {
        calls.push(question);
        return "  custom value  ";
      },
      close: () => calls.push("closed"),
    })) as unknown as typeof readline.createInterface;
    expect(await promptText("Project", "default", createInterface)).toBe("custom value");
    expect(calls).toEqual(["Project (default): ", "closed"]);

    const emptyInterface = (() => ({
      question: async () => "  ",
      close: () => {},
    })) as unknown as typeof readline.createInterface;
    expect(await promptText("Project", "default", emptyInterface)).toBe("default");
  });

  test("visible prompt helper falls back when the response is blank", async () => {
    expect(
      await promptTextWith("Name", "guest", async (question) => {
        expect(question).toBe("Name (guest): ");
        return " \t ";
      }),
    ).toBe("guest");
  });

  test("visible prompt closes its interface when asking fails", async () => {
    let closed = false;
    await expect(
      promptTextWith(
        "Name",
        "",
        async () => {
          throw new Error("read failed");
        },
        () => {
          closed = true;
        },
      ),
    ).rejects.toThrow("read failed");
    expect(closed).toBe(true);
  });

  test("hidden prompt masks input, submits trimmed text, and restores terminal mode", async () => {
    const events = new EventEmitter();
    const actions: string[] = [];
    const input = Object.assign(events, {
      isTTY: true,
      setRawMode: (enabled: boolean) => actions.push(`raw:${enabled}`),
      resume: () => actions.push("resume"),
      pause: () => actions.push("pause"),
      setEncoding: (encoding: string) => actions.push(`encoding:${encoding}`),
    });
    const output: string[] = [];
    const promise = promptHidden(
      "Key: ",
      {
        write: (text: string) => {
          output.push(text);
        },
      },
      { input },
    );
    events.emit("data", " secret \r");
    expect(await promise).toBe("secret");
    expect(output.join("")).toBe(`Key: ${"*".repeat(8)}\n`);
    expect(actions).toContain("raw:false");
    expect(actions).toContain("pause");
  });

  test("hidden prompt rejects on non-TTY input and reports cancellation", async () => {
    const noTty = Object.assign(new EventEmitter(), {
      isTTY: false,
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
    });
    await expect(promptHidden("Key", { write: () => {} }, { input: noTty })).rejects.toThrow(
      "stdin is not a TTY",
    );

    const events = new EventEmitter();
    const input = Object.assign(events, {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
    });
    let exitCode = 0;
    const promise = promptHidden(
      "Key",
      { write: () => {} },
      {
        input,
        exit: (code) => {
          exitCode = code;
        },
      },
    );
    events.emit("data", "\u0003");
    await expect(promise).rejects.toThrow("Setup cancelled");
    expect(exitCode).toBe(130);
  });
});
