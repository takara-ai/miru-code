/**
 * Regenerate .kiro-plugin/skills/ from skills/ (single source of truth).
 * Kiro's "Import from folder" doesn't follow symlinks, so the skills dir
 * has to exist as real files under .kiro-plugin/ — this script keeps that
 * copy in sync without hand-maintaining two trees. Run before importing
 * into Kiro or before submitting to kiro.dev/powers/submit.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "skills");
const dest = join(root, ".kiro-plugin", "skills");

if (!existsSync(src)) {
  console.error(`missing source dir: ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

console.log(`synced ${src} -> ${dest}`);
