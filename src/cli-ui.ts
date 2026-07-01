import { printBrandBanner } from "./brand-banner.ts";
import { bold, colorEnabled, cyan, dim, green, magenta, red, yellow } from "./terminal.ts";
import type { SearchResult } from "./types.ts";
import { formatRelevanceScore } from "./utils.ts";

export { formatBrandBannerLines, isQuietBrand, printBrandBanner } from "./brand-banner.ts";
// Re-export terminal + banner APIs for existing cli-ui consumers.
export {
  bold,
  cyan,
  dim,
  green,
  magenta,
  red,
  yellow,
} from "./terminal.ts";

export function prefersJsonOutput(jsonFlag: boolean): boolean {
  return jsonFlag || !process.stdout.isTTY;
}

export function brandTitle(): string {
  return bold("MIRU", process.stderr) + dim(" (見る)", process.stderr);
}

export function writeStdout(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function writeStderr(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function divider(char = "─", width = 52, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${dim(char.repeat(width), stream)}\n`);
}

function showBanner(stream: NodeJS.WriteStream = process.stdout): boolean {
  // Full banner replaces the plain "MIRU · title" header on color TTYs.
  if (!colorEnabled(stream)) {
    return false;
  }
  printBrandBanner(stream);
  return true;
}

export function header(): void {
  writeStdout("");
  if (!showBanner()) {
    writeStdout(brandTitle());
  }
  divider();
}

export function commandHeader(name: string, summary: string): void {
  writeStdout("");
  if (!showBanner()) {
    writeStdout(`${brandTitle()} ${name}`);
    writeStdout(summary);
  } else {
    writeStdout(summary);
  }
  divider();
}

export function section(title: string): void {
  writeStdout("");
  writeStdout(bold(title));
}

export function commandRow(name: string, description: string, indent = 2): void {
  const pad = " ".repeat(indent);
  const nameCol = name.padEnd(16);
  writeStdout(`${pad}${cyan(nameCol)} ${dim(description)}`);
}

function writeLine(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  stream.write(`${message}\n`);
}

export function success(message: string, stream?: NodeJS.WriteStream): void {
  writeLine(green("✓ ") + message, stream);
}

export function info(message: string, stream?: NodeJS.WriteStream): void {
  writeLine(dim("· ") + message, stream);
}

export function warn(message: string, stream?: NodeJS.WriteStream): void {
  writeLine(yellow("! ") + message, stream);
}

export function fail(message: string, stream?: NodeJS.WriteStream): void {
  writeLine(red("✗ ") + message, stream);
}

export function hint(message: string, stream?: NodeJS.WriteStream): void {
  writeLine(dim(`  ${message}`), stream);
}

const PREVIEW_LINES = 12;
const PREVIEW_WIDTH = 72;

function truncateLine(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }
  return `${line.slice(0, width - 1)}…`;
}

function previewContent(content: string): string[] {
  return content
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .map((line) => truncateLine(line.replace(/\t/g, "  "), PREVIEW_WIDTH));
}

export function formatSearchResultsPretty(query: string, results: SearchResult[]): string {
  const lines: string[] = [];
  const count = results.length;
  const label = count === 1 ? "1 result" : `${count} results`;

  lines.push("");
  lines.push(bold(label) + dim(` for `) + cyan(`"${query}"`));
  lines.push("");

  const maxScore = results.reduce((max, result) => Math.max(max, result?.score ?? 0), 0);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) {
      continue;
    }
    const { chunk, score } = result;
    const location = `${chunk.file_path}:${chunk.start_line}-${chunk.end_line}`;
    const lang = chunk.language ? dim(`  ${chunk.language}`) : "";
    const rank = dim(`[${i + 1}]`);
    const scoreText = magenta(formatRelevanceScore(score, maxScore));

    lines.push(`${rank} ${scoreText}  ${bold(location)}${lang}`);
    lines.push(dim("─".repeat(Math.min(PREVIEW_WIDTH, 52))));

    for (const line of previewContent(chunk.content)) {
      lines.push(dim("  ") + line);
    }

    const totalLines = chunk.content.split("\n").length;
    if (totalLines > PREVIEW_LINES) {
      lines.push(dim(`  … ${totalLines - PREVIEW_LINES} more lines`));
    }

    if (i < results.length - 1) {
      lines.push("");
    }
  }

  if (colorEnabled(process.stdout)) {
    // Only nudge interactive users; JSON output should stay machine-clean.
    lines.push("");
    lines.push(dim("Tip: add --json for machine-readable output"));
  }
  return lines.join("\n");
}

export function formatSearchErrorPretty(message: string): string {
  return `\n${yellow("No results")} ${dim("—")} ${message}\n`;
}

export function formatRelatedHeader(filePath: string, line: number): string {
  return `related to ${filePath}:${line}`;
}
