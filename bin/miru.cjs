#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.join(__dirname, "..");

function resolveBunExecutable() {
  const binName = process.platform === "win32" ? "bun.cmd" : "bun";
  const candidates = [
    path.join(packageRoot, "node_modules", ".bin", binName),
    path.join(packageRoot, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return binName;
}

const cli = path.join(packageRoot, "src", "cli.ts");
const bun = resolveBunExecutable();
const result = spawnSync(bun, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(
    "miru: failed to run Bun. Reinstall with lifecycle scripts enabled (do not use --ignore-scripts).",
  );
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
