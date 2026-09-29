import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  formatUnknownAgent,
  printCommandHelp,
  printEnvHelp,
  printEnvironmentHelp,
  printMainHelp,
  printSageMakerHelp,
} from "../src/help.ts";

const stdout = process.stdout.write;
const stderr = process.stderr.write;
let output = "";

function capture(): void {
  output = "";
  spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
}

afterEach(() => {
  process.stdout.write = stdout;
  process.stderr.write = stderr;
});

describe("help output", () => {
  test("prints main, environment, and SageMaker help", () => {
    capture();
    printMainHelp();
    expect(output).toContain("Start MCP server");
    capture();
    printEnvHelp();
    expect(output).toContain("TAKARA_API_KEY");
    expect(output).toContain("MIRU_SAGEMAKER_ENDPOINT_ARN");
    capture();
    printEnvironmentHelp();
    expect(output).toContain("MIRU_TOKENIZER_JSON");
    capture();
    printSageMakerHelp();
    expect(output).toContain("MIRU_SAGEMAKER_PROMPT_NAME");
  });

  test("prints every command help section", () => {
    for (const command of [
      "env",
      "environment",
      "search",
      "locate",
      "expand",
      "find-related",
      "setup",
      "install",
      "uninstall",
      "benchmark",
      "init",
      "clear",
      "mcp",
    ]) {
      capture();
      printCommandHelp(command);
      expect(output.length).toBeGreaterThan(0);
    }
  });

  test("exits after printing help for an unknown command", () => {
    capture();
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as typeof process.exit);
    expect(() => printCommandHelp("missing")).toThrow("exit");
    expect(output).toContain("Unknown command: missing");
    expect(output).toContain("Quick start");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("formats unknown agent message", () => {
    expect(formatUnknownAgent("other")).toContain('Unknown agent "other"');
  });
});
