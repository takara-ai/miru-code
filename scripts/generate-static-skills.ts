/**
 * Regenerate skills/caveman/, skills/ste/, and agents/miru-code.md from
 * the installer's style-pack constants and Claude agent template (single
 * source of truth). The installer writes these dynamically per-agent at
 * `miru install` time; the Claude/Codex/Cursor plugin manifests just point
 * `skills` at `./skills/`, so materializing them as real files here is all
 * three plugins need to pick up Caveman and STE for free. `agents/miru-code.md`
 * is Claude-Code-plugin-only (no `agents` field in the Cursor/Codex schema).
 * Run before tagging a plugin release; wired into pre-commit alongside the
 * .kiro-plugin/skills sync.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentTemplate } from "../src/agents.ts";
import { CAVEMAN_SKILL_MD } from "../src/installer/style-packs/caveman.ts";
import { STE_REFERENCE_FILES, STE_SKILL_MD } from "../src/installer/style-packs/ste/skill.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
  console.log(`wrote ${path}`);
}

writeFile(join(root, "skills", "caveman", "SKILL.md"), CAVEMAN_SKILL_MD);

writeFile(join(root, "skills", "ste", "SKILL.md"), STE_SKILL_MD);
for (const ref of STE_REFERENCE_FILES) {
  writeFile(join(root, "skills", "ste", ref.relativePath), ref.content);
}

const claudeSubagent = await loadAgentTemplate("claude");
writeFile(join(root, "agents", "miru-code.md"), claudeSubagent);
