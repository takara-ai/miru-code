import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillOwners } from "../src/installer/shared-skill.ts";

describe("shared skill owners file", () => {
  test("handles missing, invalid, malformed, and valid owner data", async () => {
    const skillDir = await mkdtemp(join(tmpdir(), "miru-skill-owners-"));
    try {
      expect(await readSkillOwners(skillDir)).toBeNull();
      const file = join(skillDir, "miru-owners.json");
      await Bun.write(file, "not json");
      expect(await readSkillOwners(skillDir)).toBeNull();
      await Bun.write(file, "{}\n");
      expect(await readSkillOwners(skillDir)).toBeNull();
      await Bun.write(file, '["cursor", 3, null, "vscode"]\n');
      expect(await readSkillOwners(skillDir)).toEqual(["cursor", "vscode"]);
    } finally {
      await rm(skillDir, { recursive: true, force: true });
    }
  });
});
