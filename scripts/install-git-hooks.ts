/**
 * package.json `prepare` — wire prek git hooks when developing from a clone.
 * Bun-native (no shell redirects) so `bun install` works on Windows CI.
 *
 * Skips when not a git checkout or `prek` is missing from PATH.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, ".git"))) {
  process.exit(0);
}

const prek = Bun.which("prek");
if (!prek) {
  console.log("prek not found; skipping git hook install (see CONTRIBUTING.md)");
  process.exit(0);
}

const result = Bun.spawnSync([prek, "install", "--install-hooks"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode === 0 ? 0 : (result.exitCode ?? 1));
