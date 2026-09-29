import { describe, expect, test } from "bun:test";
import { Spinner, withSpinner } from "../src/spinner.ts";

function output(isTTY = false, columns = 12) {
  const writes: string[] = [];
  return {
    writes,
    terminal: {
      isTTY,
      columns,
      write: (text: string) => {
        writes.push(text);
      },
    },
  };
}

describe("Spinner", () => {
  test("writes plain output when stderr is not a TTY", () => {
    const { writes, terminal } = output();
    const spinner = new Spinner("Working", terminal);
    spinner.start();
    spinner.follow("progress");
    spinner.stop("done");
    expect(writes).toEqual(["Working...\n", "progress\n", "done\n"]);
  });

  test("draws and restores TTY lines, accounting for wrapping", () => {
    const { writes, terminal } = output(true, 5);
    const spinner = new Spinner("Loading", terminal);
    spinner.start();
    spinner.follow("abcdefghij\néééééé");
    spinner.succeed("ready");
    expect(writes[0]).toContain("Loading");
    expect(writes).toContain("\nabcdefghij\néééééé");
    expect(writes).toContain("\x1b[4A");
    expect(writes).toContain("\x1b[4B");
    expect(writes.join("")).toContain("ready");
    expect(writes.at(-1)).toBe("\n");
  });

  test("advances the spinner frame until stopped", async () => {
    const { writes, terminal } = output(true);
    const spinner = new Spinner("Moving", terminal);
    spinner.start();
    await Bun.sleep(100);
    spinner.stop();
    expect(writes.length).toBeGreaterThan(1);
  });

  test("covers success without a message and default success and failure labels", () => {
    const { writes: firstWrites, terminal: first } = output(true);
    const spinner = new Spinner("Index", first);
    spinner.succeed("");
    expect(firstWrites).toEqual(["\r\x1b[K"]);

    const { writes, terminal } = output(true);
    const second = new Spinner("Index", terminal);
    second.succeed();
    second.fail("bad");
    expect(writes.join("")).toContain("✓ Index");
    expect(writes.join("")).toContain("✗ bad");
  });

  test("withSpinner returns success values and stops on failures", async () => {
    const { writes, terminal } = output();
    expect(await withSpinner("Index", async () => 42, {}, terminal)).toBe(42);
    await expect(
      withSpinner(
        "Index",
        async () => {
          throw new Error("failure");
        },
        {},
        terminal,
      ),
    ).rejects.toThrow("failure");
    expect(writes).toEqual(["Index...\n", "Index...\n"]);
    const custom = output();
    await withSpinner(
      "Index",
      async () => undefined,
      { successMessage: "complete" },
      custom.terminal,
    );
    expect(custom.writes).toEqual(["Index...\n", "✓ complete\n"]);
  });
});
