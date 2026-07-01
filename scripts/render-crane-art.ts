#!/usr/bin/env bun
/**
 * Half-block crane art from the official Takara vector mark.
 * Source: assets/red_crane_vector.svg
 *
 *   bun run scripts/render-crane-art.ts
 *   bun run scripts/render-crane-art.ts -- --cols 22 --rows 11
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cropCommonLeading } from "../src/terminal.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "assets", "red_crane_vector.svg");
if (!existsSync(SOURCE)) {
  throw new Error("Missing assets/red_crane_vector.svg");
}

function parseArgs(argv: string[]): { cols: number; rows: number } {
  let cols = 22;
  let rows = 11;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cols" && argv[i + 1]) {
      cols = Number(argv[++i]);
    }
    if (argv[i] === "--rows" && argv[i + 1]) {
      rows = Number(argv[++i]);
    }
  }
  return { cols, rows };
}

function isFilled(r: number, g: number, b: number, a: number): boolean {
  // Heuristic for Takara red (#d91009) on a black raster background.
  return a > 128 && r > 80 && r > g + 20 && r > b + 20;
}

function cropArtBlock(rows: string[]): string[] {
  // Tight bounding box around ink; empty rows dropped.
  const trimmed = rows.map((row) => row.trimEnd());
  let left = trimmed[0]?.length ?? 0;
  let right = 0;
  let hasContent = false;

  for (const row of trimmed) {
    const match = row.match(/\S/);
    if (!match || match.index === undefined) {
      continue;
    }
    hasContent = true;
    left = Math.min(left, match.index);
    let end = row.length;
    while (end > 0 && row[end - 1] === " ") {
      end--;
    }
    right = Math.max(right, end);
  }

  if (!hasContent) {
    return [];
  }

  const cropped = trimmed
    .map((row) => row.slice(left, right))
    .filter((row) => row.trim().length > 0);

  const width = Math.max(...cropped.map((row) => row.length));
  return cropped.map((row) => `${row}${" ".repeat(Math.max(0, width - row.length))}`);
}

async function renderCraneArt(cols: number, rows: number): Promise<string[]> {
  // Each terminal row is two raster rows (▀▄█ half-block encoding).
  const pixelH = rows * 2;
  const proc = Bun.spawn(
    [
      "magick",
      SOURCE,
      "-background",
      "black",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-resize",
      `${cols}x${pixelH}!`,
      "-depth",
      "8",
      "rgba:-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`magick failed (${code}): ${stderr}`);
  }

  const raw: string[] = [];
  for (let ty = 0; ty < rows; ty++) {
    let line = "";
    for (let tx = 0; tx < cols; tx++) {
      const topI = (ty * 2 * cols + tx) * 4;
      const botI = ((ty * 2 + 1) * cols + tx) * 4;
      const top = isFilled(
        buf[topI] ?? 0,
        buf[topI + 1] ?? 0,
        buf[topI + 2] ?? 0,
        buf[topI + 3] ?? 0,
      );
      const bot = isFilled(
        buf[botI] ?? 0,
        buf[botI + 1] ?? 0,
        buf[botI + 2] ?? 0,
        buf[botI + 3] ?? 0,
      );
      line += top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
    }
    raw.push(line);
  }

  return cropCommonLeading(cropArtBlock(raw));
}

function formatConst(name: string, lines: string[]): string {
  const body = lines.map((line) => `  ${JSON.stringify(line)},`).join("\n");
  return `const ${name} = [\n${body}\n] as const;`;
}

const { cols, rows } = parseArgs(process.argv.slice(2));
const lines = await renderCraneArt(cols, rows);

console.log(`// ${lines.length} rows × ${lines[0]?.length ?? 0} cols from ${SOURCE}`);
console.log(formatConst("TAKARA_CRANE", lines));
console.log("");
// Visual preview on stderr so stdout stays paste-ready for brand-banner.ts.
for (const line of lines) {
  console.error(line);
}
