import { describe, expect, test } from "bun:test";
import {
  STE_CHECKLIST_MD,
  STE_REFERENCE_FILES,
  STE_RULES_MD,
  STE_SKILL_MD,
  STE_SKILL_NAME,
} from "../../src/installer/style-packs/ste/skill.ts";

describe("ste style pack", () => {
  test("T1: skill export is valid markdown with frontmatter", () => {
    expect(STE_SKILL_NAME).toBe("ste");
    expect(STE_SKILL_MD.length).toBeGreaterThan(200);
    expect(STE_SKILL_MD.startsWith("---\n")).toBe(true);
    expect(STE_SKILL_MD).toContain("name: ste");
    expect(STE_SKILL_MD.indexOf("\n---\n", 4)).toBeGreaterThan(0);
  });

  test("T2: triggers and commands present", () => {
    expect(STE_SKILL_MD).toMatch(/\/ste|STE|de-slop|ASD-STE100/i);
  });

  test("T3: pragmatic and strict modes; strict mentions asd-ste100.org", () => {
    expect(STE_SKILL_MD.toLowerCase()).toContain("pragmatic");
    expect(STE_SKILL_MD.toLowerCase()).toContain("strict");
    expect(STE_SKILL_MD).toContain("asd-ste100.org");
  });

  test("T4: keep articles / anti-telegraph", () => {
    expect(STE_SKILL_MD).toMatch(/a\/an\/the|keep.*article|No telegraph/i);
    expect(STE_SKILL_MD).toMatch(/\bthat\b/);
  });

  test("T5: untouchables and marketing exclusion", () => {
    expect(STE_SKILL_MD.toLowerCase()).toContain("untouchable");
    expect(STE_SKILL_MD).toMatch(/code|paths|errors/i);
    expect(STE_SKILL_MD.toLowerCase()).toContain("marketing");
  });

  test("T6: self-check present", () => {
    expect(STE_SKILL_MD.toLowerCase()).toContain("self-check");
    expect(STE_SKILL_MD).toMatch(/1\.|2\.|3\.|4\./);
  });

  test("T7: disclaimer present", () => {
    expect(STE_SKILL_MD).toMatch(/not ASD-certified|Not ASD-certified|unofficial/i);
  });

  test("T8: references export and skill points at them", () => {
    expect(STE_REFERENCE_FILES.length).toBe(2);
    const paths = STE_REFERENCE_FILES.map((f) => f.relativePath);
    expect(paths).toContain("references/rules.md");
    expect(paths).toContain("references/checklist.md");
    expect(STE_RULES_MD.length).toBeGreaterThan(100);
    expect(STE_CHECKLIST_MD.length).toBeGreaterThan(100);
    expect(STE_SKILL_MD).toContain("references/rules.md");
    expect(STE_SKILL_MD).toContain("references/checklist.md");
  });

  test("T9: no dictionary dump", () => {
    const blob = `${STE_SKILL_MD}\n${STE_RULES_MD}\n${STE_CHECKLIST_MD}`;
    expect(blob).toMatch(/does \*\*not\*\* ship|does not ship|Do not vend|not a dictionary/i);
    // Heuristic: no huge approved-word list section
    expect(blob.length).toBeLessThan(25_000);
    expect(blob).not.toMatch(/#{1,3}\s*Approved words\s*\n(?:[-*].*\n){50,}/i);
  });

  test("T10: does not reference Caveman (separate skill; keep STE self-contained)", () => {
    expect(STE_SKILL_MD).not.toMatch(/Caveman/i);
  });
});
