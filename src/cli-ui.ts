import type { SearchResult } from "./types.ts";
import { formatRelevanceScore } from "./utils.ts";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
} as const;

function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  return stream.isTTY && process.env.NO_COLOR === undefined;
}

export function shouldShowBrandBanner(stream: NodeJS.WriteStream = process.stdout): boolean {
  return colorEnabled(stream);
}

function paint(text: string, code: string, stream?: NodeJS.WriteStream): string {
  if (!colorEnabled(stream)) {
    return text;
  }
  return `${code}${text}${ANSI.reset}`;
}

export function bold(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.bold, stream);
}

export function dim(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.dim, stream);
}

export function cyan(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.cyan, stream);
}

export function green(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.green, stream);
}

export function red(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.red, stream);
}

export function yellow(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.yellow, stream);
}

export function magenta(text: string, stream?: NodeJS.WriteStream): string {
  return paint(text, ANSI.magenta, stream);
}

export function prefersJsonOutput(jsonFlag: boolean): boolean {
  return jsonFlag || !process.stdout.isTTY;
}

function formatBrandWordmark(stream: NodeJS.WriteStream, gap = " "): string {
  return `${bold("MIRU", stream)}${gap}${cyan("見る", stream)}`;
}

export function brandTitle(): string {
  return bold("Miru", process.stderr) + dim(" (見る)", process.stderr);
}

const DEFAULT_BRAND_TAGLINE = "hybrid code search";
const BANNER_INNER_WIDTH = 29;

export function isQuietBrand(): boolean {
  const value = process.env.MIRU_QUIET?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function visibleLength(text: string): number {
  let length = 0;
  let inEscape = false;
  for (const char of text) {
    if (inEscape) {
      if (char === "m") {
        inEscape = false;
      }
      continue;
    }
    if (char === "\x1b") {
      inEscape = true;
      continue;
    }
    length += char.length;
  }
  return length;
}

function padVisible(text: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(pad)}`;
}

export function formatBrandBannerLines(
  tagline = DEFAULT_BRAND_TAGLINE,
  stream: NodeJS.WriteStream = process.stdout,
): string[] {
  const title = formatBrandWordmark(stream, "  ");
  const subtitle = dim(tagline, stream);
  const top = `  ╭${"─".repeat(BANNER_INNER_WIDTH + 2)}╮`;
  const bottom = `  ╰${"─".repeat(BANNER_INNER_WIDTH + 2)}╯`;
  return [
    top,
    `  │ ${padVisible(title, BANNER_INNER_WIDTH)} │`,
    `  │ ${padVisible(subtitle, BANNER_INNER_WIDTH)} │`,
    bottom,
  ];
}

export function formatBrandCompactLine(
  tagline?: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  const title = formatBrandWordmark(stream);
  if (!tagline) {
    return title;
  }
  return `${title}${dim(` · ${tagline}`, stream)}`;
}

export function printCompactBrandIfInteractive(
  jsonFlag: boolean,
  stream: NodeJS.WriteStream = process.stdout,
): void {
  if (!prefersJsonOutput(jsonFlag) && shouldShowBrandBanner(stream)) {
    printBrandBanner({ stream, compact: true });
  }
}

export interface PrintBrandBannerOptions {
  stream?: NodeJS.WriteStream;
  tagline?: string;
  compact?: boolean;
}

export function printBrandBanner(options: PrintBrandBannerOptions = {}): void {
  const stream = options.stream ?? process.stdout;
  if (!shouldShowBrandBanner(stream)) {
    return;
  }

  const tagline = options.tagline ?? DEFAULT_BRAND_TAGLINE;
  const useCompact = options.compact || (stream.columns ?? 80) < 36 || isQuietBrand();

  if (useCompact) {
    stream.write(`${formatBrandCompactLine(tagline, stream)}\n`);
    return;
  }

  for (const line of formatBrandBannerLines(tagline, stream)) {
    stream.write(`${line}\n`);
  }
}

export function writeStdout(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function writeStderr(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function divider(char = "─", width = 52, stream: NodeJS.WriteStream = process.stdout): void {
  const line = char.repeat(width);
  stream.write(`${dim(line, stream)}\n`);
}

export function header(title: string, subtitle?: string): void {
  writeStdout("");
  const tagline = subtitle ?? title;
  if (shouldShowBrandBanner(process.stdout)) {
    printBrandBanner({ stream: process.stdout, tagline });
  } else {
    writeStdout(brandTitle() + (title ? dim(` · ${title}`) : ""));
    if (subtitle) {
      writeStdout(dim(subtitle));
    }
  }
  divider();
}

export function commandHeader(name: string, summary: string): void {
  writeStdout("");
  if (shouldShowBrandBanner(process.stdout)) {
    printBrandBanner({ stream: process.stdout, tagline: name });
    writeStdout(summary);
  } else {
    writeStdout(`${brandTitle()} ${name}`);
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

  if (shouldShowBrandBanner(process.stdout)) {
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
