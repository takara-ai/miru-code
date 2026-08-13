import { describe, expect, test } from "bun:test";
import { nextConfirmYesSelected, parseInstallerKeyForTest } from "../src/installer/prompt.ts";

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
});
