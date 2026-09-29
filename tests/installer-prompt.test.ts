import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import {
  nextConfirmYesSelected,
  parseInstallerKeyForTest,
  promptConfirm,
  promptMultiSelect,
  promptMultiSelectLegacy,
  requireInteractiveTerminal,
} from "../src/installer/prompt.ts";

function scriptedIo(answer: string) {
  const input = new PassThrough();
  const outputText: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText.push(Buffer.from(chunk).toString());
      callback();
    },
  });
  input.end(answer);
  return {
    input: input as unknown as typeof process.stdin,
    output: output as unknown as typeof process.stdout,
    outputText,
  };
}

async function withFakeTerminal<T>(keys: Array<string | Error>, run: () => Promise<T>): Promise<T> {
  const input = process.stdin as NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const output = process.stdout;
  const original = {
    isTTY: input.isTTY,
    once: input.once,
    resume: input.resume,
    pause: input.pause,
    setRawMode: input.setRawMode,
    write: output.write,
  };
  input.isTTY = true;
  input.setRawMode = (() => input) as typeof input.setRawMode;
  input.resume = (() => input) as typeof input.resume;
  input.pause = (() => input) as typeof input.pause;
  input.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const result = original.once.call(input, event, listener);
    if (event === "data") {
      const next = keys.shift();
      if (next) {
        setImmediate(() => {
          if (next instanceof Error) input.emit("error", next);
          else input.emit("data", Buffer.from(next));
        });
      }
    }
    return result;
  }) as typeof input.once;
  output.write = (() => true) as typeof output.write;
  try {
    return await run();
  } finally {
    input.isTTY = original.isTTY;
    input.once = original.once;
    input.resume = original.resume;
    input.pause = original.pause;
    input.setRawMode = original.setRawMode;
    output.write = original.write;
  }
}

describe("installer prompt key parsing", () => {
  test("parses ANSI CSI arrow sequences", () => {
    expect(parseInstallerKeyForTest(Buffer.from("\x1b[A", "utf8"))).toBe("up");
    expect(parseInstallerKeyForTest(Buffer.from("\x1b[B", "utf8"))).toBe("down");
    expect(parseInstallerKeyForTest(Buffer.from("\x1b[C", "utf8"))).toBe("right");
    expect(parseInstallerKeyForTest(Buffer.from("\x1b[D", "utf8"))).toBe("left");
  });

  test("parses ANSI SS3 arrow sequences", () => {
    expect(parseInstallerKeyForTest(Buffer.from("\x1bOA", "utf8"))).toBe("up");
    expect(parseInstallerKeyForTest(Buffer.from("\x1bOB", "utf8"))).toBe("down");
    expect(parseInstallerKeyForTest(Buffer.from("\x1bOC", "utf8"))).toBe("right");
    expect(parseInstallerKeyForTest(Buffer.from("\x1bOD", "utf8"))).toBe("left");
  });

  test("parses windows scan-code arrow sequences", () => {
    expect(parseInstallerKeyForTest(Buffer.from([0xe0, 0x48]))).toBe("up");
    expect(parseInstallerKeyForTest(Buffer.from([0xe0, 0x50]))).toBe("down");
    expect(parseInstallerKeyForTest(Buffer.from([0xe0, 0x4d]))).toBe("right");
    expect(parseInstallerKeyForTest(Buffer.from([0xe0, 0x4b]))).toBe("left");
    expect(parseInstallerKeyForTest(Buffer.from([0x00, 0x00]))).toBe("\u0000\u0000");
    expect(parseInstallerKeyForTest(Buffer.from("\u001bXA"))).toBe("\u001bXA");
    expect(parseInstallerKeyForTest(Buffer.from("a"))).toBe("all");
    expect(parseInstallerKeyForTest(Buffer.from("Y"))).toBe("yes");
    expect(parseInstallerKeyForTest(Buffer.from("n"))).toBe("no");
  });
});

describe("confirm arrow selection", () => {
  test("left/right follow Yes / No layout; y/n still work", () => {
    expect(nextConfirmYesSelected(false, "left")).toBe(true);
    expect(nextConfirmYesSelected(true, "right")).toBe(false);
    expect(nextConfirmYesSelected(false, "yes")).toBe(true);
    expect(nextConfirmYesSelected(true, "no")).toBe(false);
    expect(nextConfirmYesSelected(true, "enter")).toBe(true);
  });

  test("non-TTY confirm honors default and explicit yes/no answers", async () => {
    const emptyYes = scriptedIo("\n");
    expect(await promptConfirm("Continue?", true, emptyYes)).toBe(true);
    const emptyNo = scriptedIo("\n");
    expect(await promptConfirm("Continue?", false, emptyNo)).toBe(false);
    expect(await promptConfirm("Continue?", true, scriptedIo("YES\n"))).toBe(true);
    expect(await promptConfirm("Continue?", true, scriptedIo("no\n"))).toBe(false);
  });

  test("legacy multi-select supports defaults, all, invalid and indexed answers", async () => {
    const items = [
      { label: "one", value: 1, checked: true },
      { label: "two", value: 2, checked: false },
      { label: "three", value: 3, checked: true },
    ];
    expect(await promptMultiSelectLegacy("Choices", items, scriptedIo("\n"))).toEqual([1, 3]);
    expect(await promptMultiSelectLegacy("Choices", items, scriptedIo("all\n"))).toEqual([1, 2, 3]);
    expect(await promptMultiSelectLegacy("Choices", items, scriptedIo("invalid\n"))).toBeNull();
    expect(await promptMultiSelectLegacy("Choices", items, scriptedIo("3, 1, 99, 1\n"))).toEqual([
      1, 3,
    ]);
  });

  test("requires a TTY and drives interactive selectors", async () => {
    const input = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const previous = input.isTTY;
    input.isTTY = false;
    expect(() => requireInteractiveTerminal("install")).toThrow("requires an interactive terminal");
    expect(
      await promptMultiSelect("Choices", [
        { label: "one", value: 1, checked: true },
        { label: "two", value: 2, checked: false },
      ]),
    ).toEqual([1]);
    input.isTTY = previous;

    const selected = await withFakeTerminal(["\x1b[B", " ", "\x1b[A", "\r"], () =>
      promptMultiSelect("Choices", [
        { label: "one", value: 1, checked: true },
        { label: "two", value: 2, checked: false },
      ]),
    );
    expect(selected).toEqual([1, 2]);
    expect(await withFakeTerminal(["\x1b[C", "\x03"], () => promptConfirm("Continue?"))).toBe(
      false,
    );
    expect(await withFakeTerminal(["\x1b[D", "\r"], () => promptConfirm("Continue?", false))).toBe(
      true,
    );
    expect(
      await withFakeTerminal(["a", "\r"], () =>
        promptMultiSelect("All", [
          { label: "one", value: 1, checked: false },
          { label: "two", value: 2, checked: false },
        ]),
      ),
    ).toEqual([1, 2]);
    expect(
      await withFakeTerminal(["a", "a", "\r"], () =>
        promptMultiSelect("All", [
          { label: "one", value: 1, checked: false },
          { label: "two", value: 2, checked: false },
        ]),
      ),
    ).toEqual([]);
    expect(await promptMultiSelect("Empty", [])).toEqual([]);
    expect(
      await withFakeTerminal(["\x03"], () =>
        promptMultiSelect("Cancel", [{ label: "one", value: 1, checked: false }]),
      ),
    ).toBeNull();
  });

  test("TTY prompt restores raw mode after input errors", async () => {
    const error = new Error("terminal read failed");
    await expect(withFakeTerminal([error], () => promptConfirm("Continue?"))).rejects.toThrow(
      "terminal read failed",
    );
  });
});
