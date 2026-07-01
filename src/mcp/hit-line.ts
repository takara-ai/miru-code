import * as z from "zod";

export const HIT_LINE_TOOLS = new Set(["expand", "find_related"]);

export const hitLineInputSchema = {
  line: z
    .number()
    .int()
    .describe(
      "1-indexed line from a search hit. You may pass `anchor_line` or `start_line` instead.",
    ),
  anchor_line: z
    .number()
    .int()
    .optional()
    .describe("Line from a truncated search hit (`anchor_line` field)."),
  start_line: z
    .number()
    .int()
    .optional()
    .describe("Line from a non-truncated search hit (`start_line` field)."),
} as const;

/** Map search-hit field names (`anchor_line`, `start_line`) to the schema `line` param. */
export function normalizeHitLineArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.line !== undefined) {
    return args;
  }
  if (args.anchor_line !== undefined) {
    return { ...args, line: args.anchor_line };
  }
  if (args.start_line !== undefined) {
    return { ...args, line: args.start_line };
  }
  return args;
}
