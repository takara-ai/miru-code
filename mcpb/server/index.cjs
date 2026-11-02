#!/usr/bin/env node
// Launches the published Miru MCP server with Bun. The package version follows
// manifest.json, which release-please bumps on each release.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { version } = require("../manifest.json");

/** Unset optional user_config values arrive empty or as the raw placeholder. */
function configured(value) {
  return value && !value.startsWith("${") ? value : undefined;
}

const env = { ...process.env };
for (const name of ["TAKARA_API_KEY", "MIRU_DEFAULT_REPO"]) {
  if (!configured(env[name])) {
    delete env[name];
  }
}
const cwd =
  env.MIRU_DEFAULT_REPO && existsSync(env.MIRU_DEFAULT_REPO) ? env.MIRU_DEFAULT_REPO : undefined;

const child = spawn("bunx", [`@takara-ai/miru-code@${version}`, "mcp"], {
  cwd,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.error(
    err.code === "ENOENT"
      ? "Miru needs Bun on PATH: https://bun.sh/docs/installation"
      : `Failed to start Miru: ${err.message}`,
  );
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
