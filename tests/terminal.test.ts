import { afterEach, describe, expect, test } from "bun:test";
import { brandColor, colorEnabled, hexToRgb } from "../src/terminal.ts";

const TAKARA_RED: readonly [number, number, number] = [217, 16, 9];

const ttyStream = { isTTY: true } as NodeJS.WriteStream;

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const merged = { NO_COLOR: undefined, ...values };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(merged)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("terminal colors", () => {
  afterEach(() => {
    delete process.env.COLORTERM;
    delete process.env.TERM;
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
  });

  test("brandColor uses 256-color when COLORTERM is unset", () => {
    withEnv({ TERM: "xterm-256color", COLORTERM: undefined }, () => {
      const colored = brandColor("█", TAKARA_RED, ttyStream);
      expect(colored).toContain("\x1b[1;38;5;160m");
    });
  });

  test("brandColor uses truecolor when COLORTERM is set", () => {
    withEnv({ COLORTERM: "truecolor", TERM: "xterm-256color" }, () => {
      const colored = brandColor("█", TAKARA_RED, ttyStream);
      expect(colored).toContain("\x1b[1;38;2;217;16;9m");
    });
  });

  test("brandColor leaves text plain when color is disabled", () => {
    withEnv({ NO_COLOR: "1", TERM: "xterm-256color" }, () => {
      expect(colorEnabled(ttyStream)).toBe(false);
      expect(brandColor("█", TAKARA_RED, ttyStream)).toBe("█");
    });
  });

  test("hexToRgb parses Takara brand hex values", () => {
    expect(hexToRgb("#4a4d4e")).toEqual([74, 77, 78]);
    expect(hexToRgb("#d91009")).toEqual([217, 16, 9]);
    expect(hexToRgb("d91009")).toEqual([217, 16, 9]);
  });

  test("hexToRgb rejects invalid input", () => {
    expect(() => hexToRgb("#fff")).toThrow("Invalid hex color");
  });
});
