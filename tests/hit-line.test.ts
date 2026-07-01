import { describe, expect, test } from "bun:test";
import { normalizeHitLineArgs } from "../src/mcp/hit-line.ts";

describe("normalizeHitLineArgs", () => {
  test("maps anchor_line to line", () => {
    expect(normalizeHitLineArgs({ anchor_line: 94, file_path: "a.ts" })).toEqual({
      anchor_line: 94,
      file_path: "a.ts",
      line: 94,
    });
  });

  test("maps start_line to line", () => {
    expect(normalizeHitLineArgs({ start_line: 12, file_path: "a.ts" })).toEqual({
      start_line: 12,
      file_path: "a.ts",
      line: 12,
    });
  });

  test("prefers explicit line over aliases", () => {
    expect(normalizeHitLineArgs({ line: 1, anchor_line: 94 })).toEqual({
      line: 1,
      anchor_line: 94,
    });
  });

  test("prefers anchor_line over start_line", () => {
    expect(normalizeHitLineArgs({ anchor_line: 94, start_line: 12 })).toEqual({
      anchor_line: 94,
      start_line: 12,
      line: 94,
    });
  });

  test("leaves args unchanged when no line fields are present", () => {
    expect(normalizeHitLineArgs({ file_path: "a.ts" })).toEqual({ file_path: "a.ts" });
  });
});
