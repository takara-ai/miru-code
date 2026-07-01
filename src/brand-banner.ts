/**
 * Framed CLI banner: wordmark + Takara crane art + subtitle.
 * Shown on interactive help/setup when the output stream is a color TTY.
 * Regenerate crane rows with: bun run scripts/render-crane-art.ts
 */
import packageJson from "../package.json";
import {
  brandColor,
  colorEnabled,
  dim,
  displayWidth,
  hexToRgb,
  padLineToWidth,
} from "./terminal.ts";

const BRAND_SUBTITLE = "hybrid code search for agents by takara.ai";
const BRAND_INDENT = "  ";
const BRAND_WELCOME = "Welcome to Miru";
const COLUMN_GAP = 4;
const BANNER_MIN_COLUMNS = 72; // below this width, print subtitle only (compact mode)

// Takara brand palette — hex is source of truth; RGB derived for ANSI SGR.
const BRAND_HEX = {
  grey: "#4a4d4e",
  red: "#d91009",
} as const;

const BRAND_RGB = {
  grey: hexToRgb(BRAND_HEX.grey),
  red: hexToRgb(BRAND_HEX.red),
} as const satisfies Record<string, readonly [number, number, number]>;

const MIRU_WORDMARK = [
  "███╗   ███╗ ██╗ ██████╗  ██╗   ██╗",
  "████╗ ████║ ██║ ██╔══██╗ ██║   ██║",
  "██╔████╔██║ ██║ ██████╔╝ ██║   ██║",
  "██║╚██╔╝██║ ██║ ██╔══██╗ ██║   ██║",
  "██║ ╚═╝ ██║ ██║ ██║  ██║ ╚██████╔╝",
  "╚═╝     ╚═╝ ╚═╝ ╚═╝  ╚═╝  ╚═════╝ ",
] as const;

// Padded rows preserve crane silhouette when merged beside the wordmark.
// Do not crop per-row leading spaces — that breaks the half-block shape.
const TAKARA_CRANE = [
  "█▄                    ",
  " ▀█▄          ▄▄██    ",
  "  ▀██       ▄████▀    ",
  "   ▀██▄  ▄███████     ",
  "     ███████████ ▄██▄ ",
  "     ▄█████████▄██▀▀█▄",
  "    ▄████████████▀   ▀",
  "    ███████████▀      ",
  "   ███████▀  ▀        ",
  "  ▄████▀              ",
  "  ██▀                 ",
];

export function isQuietBrand(): boolean {
  // MIRU_QUIET=1 skips the framed banner on narrow or scripted terminals.
  const value = process.env.MIRU_QUIET?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function colorCell(
  plain: string,
  width: number,
  rgb: readonly [number, number, number],
  stream: NodeJS.WriteStream,
): string {
  if (!plain) {
    return " ".repeat(width);
  }
  return padLineToWidth(brandColor(plain, rgb, stream), width);
}

function mergeArt(
  stream: NodeJS.WriteStream,
  leftWidth: number,
  rightWidth: number,
  wordmarkStart: number,
): string[] {
  // Crane is taller than the wordmark; offset wordmark rows so both are vertically centered.
  const height = Math.max(wordmarkStart + MIRU_WORDMARK.length, TAKARA_CRANE.length);
  const gap = " ".repeat(COLUMN_GAP);
  const rows: string[] = [];

  for (let i = 0; i < height; i++) {
    const wordmark =
      i >= wordmarkStart && i < wordmarkStart + MIRU_WORDMARK.length
        ? (MIRU_WORDMARK[i - wordmarkStart] ?? "")
        : "";
    const crane = i < TAKARA_CRANE.length ? (TAKARA_CRANE[i] ?? "") : "";
    rows.push(
      colorCell(wordmark, leftWidth, BRAND_RGB.grey, stream) +
        gap +
        colorCell(crane, rightWidth, BRAND_RGB.red, stream),
    );
  }

  return rows;
}

function frameLine(prefix: string, suffix: string, frameWidth: number): string {
  const pad = Math.max(0, frameWidth - displayWidth(prefix) - displayWidth(suffix));
  return `${prefix}${" ".repeat(pad)}${suffix}`;
}

export function formatBrandBannerLines(stream: NodeJS.WriteStream = process.stdout): string[] {
  const versionLabel = `Version ${packageJson.version}`;
  const leftWidth = Math.max(...MIRU_WORDMARK.map(displayWidth));
  const rightWidth = Math.max(...TAKARA_CRANE.map(displayWidth));
  // Frame must fit art and corner labels (welcome top-left, version bottom-right).
  const frameWidth = Math.max(
    leftWidth + COLUMN_GAP + rightWidth,
    displayWidth(`┌ ${BRAND_WELCOME}`) + 1,
    displayWidth(`└ ${versionLabel} ┘`),
  );
  const wordmarkStart = Math.max(0, Math.floor((TAKARA_CRANE.length - MIRU_WORDMARK.length) / 2));

  const lines = [
    frameLine(`┌ ${dim(BRAND_WELCOME, stream)}`, "┐", frameWidth),
    ...mergeArt(stream, leftWidth, rightWidth, wordmarkStart).map((line) =>
      padLineToWidth(line, frameWidth),
    ),
    frameLine("└", `${dim(versionLabel, stream)} ┘`, frameWidth),
    "",
    padLineToWidth(dim(BRAND_SUBTITLE, stream), frameWidth),
  ];

  return lines.map((line) => (line.length > 0 ? `${BRAND_INDENT}${line}` : line));
}

export function printBrandBanner(
  stream: NodeJS.WriteStream = process.stdout,
  compact = false,
): void {
  // No ANSI on pipes, CI logs, or when NO_COLOR is set.
  if (!colorEnabled(stream)) {
    return;
  }

  const useCompact = compact || (stream.columns ?? 80) < BANNER_MIN_COLUMNS || isQuietBrand();
  if (useCompact) {
    stream.write(`${dim(BRAND_SUBTITLE, stream)}\n`);
    return;
  }

  for (const line of formatBrandBannerLines(stream)) {
    stream.write(`${line}\n`);
  }
}
