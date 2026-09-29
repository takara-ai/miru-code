import { afterEach, describe, expect, test } from "bun:test";
import {
  brandColor,
  colorEnabled,
  cropCommonLeading,
  displayWidth,
  hexToRgb,
  padLineToWidth,
} from "../src/terminal.ts";

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

  test("brandColor honors FORCE_COLOR and grayscale palette shortcuts", () => {
    withEnv({ FORCE_COLOR: "3", COLORTERM: undefined }, () => {
      expect(brandColor("x", TAKARA_RED, ttyStream)).toContain("38;2;");
    });
    withEnv({ FORCE_COLOR: undefined, COLORTERM: undefined }, () => {
      expect(brandColor("x", [0, 0, 0], ttyStream)).toContain("38;5;16m");
      expect(brandColor("x", [255, 255, 255], ttyStream)).toContain("38;5;231m");
      expect(brandColor("x", [128, 129, 127], ttyStream)).toContain("38;5;");
    });
    expect(colorEnabled({ isTTY: false } as NodeJS.WriteStream)).toBe(false);
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

  test("crops shared indentation, trims trailing spaces, and preserves blank art", () => {
    expect(cropCommonLeading(["    first  ", "      second", "  third"])).toEqual([
      "  first",
      "    second",
      "third",
    ]);
    expect(cropCommonLeading(["   ", "  "])).toEqual(["", ""]);
    expect(cropCommonLeading([])).toEqual([]);
  });

  test("measures terminal columns with combining, wide, control, and ANSI characters", () => {
    expect(displayWidth("a\u0301\0中🙂")).toBe(5);
    expect(displayWidth("\x1b[31mred\x1b[0m")).toBe(3);
    expect(displayWidth("\x1b[31red")).toBe(0);
    expect(padLineToWidth("中", 4)).toBe("中  ");
    expect(padLineToWidth("long", 2)).toBe("long");
  });

  test("recognizes 24bit COLORTERM and maps grayscale palette values", () => {
    withEnv({ COLORTERM: "24bit", FORCE_COLOR: undefined }, () => {
      expect(brandColor("x", TAKARA_RED, ttyStream)).toContain("38;2;");
    });
    withEnv({ COLORTERM: undefined, FORCE_COLOR: undefined }, () => {
      expect(brandColor("x", [0, 1, 2], ttyStream)).toContain("38;5;16m");
      expect(brandColor("x", [250, 250, 250], ttyStream)).toContain("38;5;231m");
    });
  });
});
