import { describe, expect, test } from "bun:test";
import { CAVEMAN_SKILL_MD, CAVEMAN_SKILL_NAME } from "../../src/installer/style-packs/caveman.ts";

describe("caveman style pack", () => {
  test("T1: skill export is non-empty valid markdown with frontmatter", () => {
    expect(CAVEMAN_SKILL_NAME).toBe("caveman");
    expect(CAVEMAN_SKILL_MD.length).toBeGreaterThan(200);
    expect(CAVEMAN_SKILL_MD.startsWith("---\n")).toBe(true);
    expect(CAVEMAN_SKILL_MD).toContain("name: caveman");
    const closed = CAVEMAN_SKILL_MD.indexOf("\n---\n", 4);
    expect(closed).toBeGreaterThan(0);
  });

  test("T2: required commands and intensity levels present", () => {
    expect(CAVEMAN_SKILL_MD).toContain("/caveman");
    expect(CAVEMAN_SKILL_MD).toContain("lite");
    expect(CAVEMAN_SKILL_MD).toContain("full");
    expect(CAVEMAN_SKILL_MD).toContain("ultra");
    expect(CAVEMAN_SKILL_MD).toContain("stop caveman");
    expect(CAVEMAN_SKILL_MD).toContain("normal mode");
  });

  test("T3: guardrails present", () => {
    const lower = CAVEMAN_SKILL_MD.toLowerCase();
    expect(lower).toContain("auto-clarity");
    expect(lower).toContain("security");
    expect(CAVEMAN_SKILL_MD).toMatch(/destructive|irreversible/i);
    expect(lower).toContain("never sacrifice");
    expect(CAVEMAN_SKILL_MD).toMatch(/code fence|byte-exact|paths/i);
    expect(CAVEMAN_SKILL_MD).toMatch(/persisted|commits|PR|README/i);
    expect(CAVEMAN_SKILL_MD).toMatch(/must not omit|never omit|brevity never hides/i);
  });

  test("T4: three before/after examples present", () => {
    expect(CAVEMAN_SKILL_MD).toMatch(/factual lookup|lookup/i);
    expect(CAVEMAN_SKILL_MD).toMatch(/recommendation/i);
    expect(CAVEMAN_SKILL_MD).toMatch(/debug|failure/i);
    expect(CAVEMAN_SKILL_MD).toContain("**Before:**");
    expect(CAVEMAN_SKILL_MD).toContain("**After (full):**");
    const beforeCount = CAVEMAN_SKILL_MD.split("**Before:**").length - 1;
    expect(beforeCount).toBeGreaterThanOrEqual(3);
  });

  test("T5: inspired-by credit present", () => {
    expect(CAVEMAN_SKILL_MD).toContain("JuliusBrussee/caveman");
  });
});
