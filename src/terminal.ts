/**
 * Terminal helpers: ANSI styling, display-width layout, and brand RGB colors.
 * Brand colors use truecolor when COLORTERM says so; otherwise 256-color palette
 * (Terminal.app often omits COLORTERM but still renders 38;5 correctly).
 */
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

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  // https://no-color.org — any NO_COLOR value disables styling.
  return stream.isTTY && process.env.NO_COLOR === undefined;
}

function paint(text: string, code: string, stream?: NodeJS.WriteStream): string {
  if (!colorEnabled(stream)) {
    return text;
  }
  return `${code}${text}${ANSI.reset}`;
}

const style =
  (code: string) =>
  (text: string, stream?: NodeJS.WriteStream): string =>
    paint(text, code, stream);

export const bold = style(ANSI.bold);
export const dim = style(ANSI.dim);
export const cyan = style(ANSI.cyan);
export const green = style(ANSI.green);
export const red = style(ANSI.red);
export const yellow = style(ANSI.yellow);
export const magenta = style(ANSI.magenta);

function charWidth(codePoint: number): number {
  // East Asian and emoji runes count as two columns in most terminals.
  if (codePoint === 0) {
    return 0;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  // Ignore ANSI SGR sequences when measuring layout width.
  let width = 0;
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
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function padLineToWidth(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

/** Parse `#rrggbb` into `[r, g, b]` for terminal truecolor/256-color SGR. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

export function cropCommonLeading(rows: readonly string[]): string[] {
  // Trim shared left margin from sampled art without shifting rows relative to each other.
  const trimmed = rows.map((row) => row.trimEnd());
  let minLead = trimmed[0]?.length ?? 0;
  let hasContent = false;

  for (const row of trimmed) {
    if (!row.trim()) {
      continue;
    }
    hasContent = true;
    minLead = Math.min(minLead, row.length - row.trimStart().length);
  }

  if (!hasContent) {
    return [...trimmed];
  }
  return trimmed.map((row) => row.slice(minLead));
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  const avg = Math.round((r + g + b) / 3);
  if (Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3) {
    if (avg < 8) {
      return 16;
    }
    if (avg > 248) {
      return 231;
    }
    return Math.round(((avg - 8) / 247) * 24) + 232;
  }
  return (
    16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
  );
}

function brandSgr(rgb: readonly [number, number, number]): string {
  const [r, g, b] = rgb;
  const colorTerm = process.env.COLORTERM?.toLowerCase() ?? "";
  // termstandard/colors: COLORTERM=truecolor|24bit → 24-bit SGR; else 256-color cube.
  const truecolor =
    process.env.FORCE_COLOR === "3" ||
    colorTerm.includes("truecolor") ||
    colorTerm.includes("24bit");
  if (truecolor) {
    return `\x1b[1;38;2;${r};${g};${b}m`;
  }
  return `\x1b[1;38;5;${rgbToAnsi256(r, g, b)}m`;
}

export function brandColor(
  text: string,
  rgb: readonly [number, number, number],
  stream: NodeJS.WriteStream = process.stdout,
): string {
  if (!colorEnabled(stream)) {
    return text;
  }
  return `${brandSgr(rgb)}${text}${ANSI.reset}`;
}
