import { expect, test } from "bun:test";
import {
  parseContentArgv,
  parseExpandArgs,
  parseLocateArgs,
  parseMcpArgs,
  UsageError,
} from "../src/cli-args.ts";

test("parseLocateArgs collects flags and the first positional as path", () => {
  const { options, pathArg } = parseLocateArgs([
    "--mode",
    "files",
    "--limit",
    "5",
    "--include",
    "src/**",
    "--include",
    "lib/**",
    "--ignore-case",
    "repo",
  ]);
  expect(options).toEqual({
    mode: "files",
    limit: 5,
    include: ["src/**", "lib/**"],
    ignore_case: true,
  });
  expect(pathArg).toBe("repo");
});

test("parseLocateArgs rejects bad values", () => {
  expect(() => parseLocateArgs(["--mode", "nope"])).toThrow(UsageError);
  expect(() => parseLocateArgs(["--limit", "0"])).toThrow("locate --limit must be an integer ≥ 1.");
  expect(() => parseLocateArgs(["--context"])).toThrow("Missing value for --context.");
});

test("parseExpandArgs defaults and rejects NaN", () => {
  expect(parseExpandArgs([])).toEqual({ before: 1, after: 1 });
  expect(parseExpandArgs(["--before", "3", "--after", "0"])).toEqual({ before: 3, after: 0 });
  expect(() => parseExpandArgs(["--before", "abc"])).toThrow(UsageError);
});

test("parseContentArgv stops at the next flag", () => {
  const { rest } = parseContentArgv(["q", "--content", "code", "--json", "path"]);
  expect(rest).toEqual(["q", "--json", "path"]);
});

test("parseMcpArgs reads ref, benchmark, and content", () => {
  const args = parseMcpArgs(["--ref", "main", "--benchmark", "--content", "code"]);
  expect(args.ref).toBe("main");
  expect(args.benchmark).toBe(true);
  expect(parseMcpArgs(["--benchmark=false"]).benchmark).toBe(false);
});
