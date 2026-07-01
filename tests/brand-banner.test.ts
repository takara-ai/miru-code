import { describe, expect, test } from "bun:test";
import { formatBrandBannerLines, isQuietBrand, printBrandBanner } from "../src/brand-banner.ts";
import { displayWidth } from "../src/terminal.ts";

describe("brand-banner", () => {
  test("formatBrandBannerLines renders framed banner with crane and subtitle", () => {
    const lines = formatBrandBannerLines();
    const text = lines.join("\n");
    expect(text).toContain("█");
    expect(text).toContain("hybrid code search for agents by takara.ai");
    expect(text).toContain("███▄");
    expect(text).toContain("┌");
    expect(text).toContain("┐");
    expect(text).toContain("Welcome to Miru");
    expect(text).toContain("Version");
  });

  test("formatBrandBannerLines stays within the 80-column budget", () => {
    const lines = formatBrandBannerLines({
      isTTY: false,
    } as NodeJS.WriteStream);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("formatBrandBannerLines aligns framed rows to one display width", () => {
    const lines = formatBrandBannerLines({
      isTTY: false,
    } as NodeJS.WriteStream).filter(
      (line) =>
        line.includes("┌") || line.includes("└") || line.includes("█") || line.includes("▀"),
    );
    const widths = new Set(lines.map(displayWidth));
    expect(widths.size).toBe(1);
  });

  test("printBrandBanner compact mode shows brand subtitle", () => {
    const lines: string[] = [];
    const stream = {
      isTTY: true,
      columns: 40,
      write(chunk: string) {
        lines.push(chunk);
      },
    } as unknown as NodeJS.WriteStream;
    printBrandBanner(stream, true);
    expect(lines.join("")).toContain("hybrid code search for agents by takara.ai");
  });

  test("isQuietBrand reads MIRU_QUIET", () => {
    const previous = process.env.MIRU_QUIET;
    process.env.MIRU_QUIET = "1";
    expect(isQuietBrand()).toBe(true);
    if (previous === undefined) {
      delete process.env.MIRU_QUIET;
    } else {
      process.env.MIRU_QUIET = previous;
    }
  });
});
