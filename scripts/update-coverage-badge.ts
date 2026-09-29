import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const inputPath = process.env.BUN_COVERAGE_LCOV ?? "coverage/lcov.info";
const outputPath = "docs/coverage-badge.json";
const checkOnly = Bun.argv.includes("--check");
const sourceRoot = resolve("src");

const lcov = await readFile(inputPath, "utf8");
let inSourceFile = false;
let linesFound = 0;
let linesHit = 0;

for (const line of lcov.split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    const sourcePath = line.slice(3).replaceAll("\\", "/");
    const relativePath = relative(sourceRoot, resolve(sourcePath));
    inSourceFile =
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath);
    continue;
  }

  if (!inSourceFile) continue;

  if (line.startsWith("LF:")) {
    linesFound += parseCount(line, "LF:");
  } else if (line.startsWith("LH:")) {
    linesHit += parseCount(line, "LH:");
  }
}

if (linesFound === 0 || linesHit > linesFound) {
  throw new Error(`No valid src/ line coverage found in ${inputPath}`);
}

const percentage = (linesHit / linesFound) * 100;
const color =
  percentage >= 90
    ? "brightgreen"
    : percentage >= 80
      ? "green"
      : percentage >= 70
        ? "yellowgreen"
        : percentage >= 60
          ? "yellow"
          : percentage >= 50
            ? "orange"
            : "red";
const badge = `${JSON.stringify(
  {
    schemaVersion: 1,
    label: "coverage",
    message: `${percentage.toFixed(1)}%`,
    color,
  },
  null,
  2,
)}\n`;

if (checkOnly) {
  const committed = await readFile(outputPath, "utf8");
  if (committed !== badge) {
    console.error(
      `Coverage badge is out of date (Bun reports ${percentage.toFixed(1)}% for src/). Run: bun run coverage:badge`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Coverage badge matches Bun's ${percentage.toFixed(1)}% src/ line coverage.`);
  }
} else {
  await writeFile(outputPath, badge);
  console.log(`Updated ${outputPath}: ${percentage.toFixed(1)}% src/ line coverage.`);
}

function parseCount(line: string, prefix: "LF:" | "LH:"): number {
  const value = Number(line.slice(prefix.length));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid LCOV count: ${line}`);
  }
  return value;
}
