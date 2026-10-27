import { describe, expect, test } from "bun:test";
import {
  buildReleaseCard,
  parseRelease,
  releaseHighlights,
  wrapText,
} from "../scripts/generate-release-card.ts";

describe("release card highlights", () => {
  test("uses release notes, removes commit metadata, and omits routine maintenance", () => {
    expect(
      releaseHighlights(`### Bug Fixes
* **coverage:** refresh badge ([670e180](https://github.com/takara-ai/miru-code/commit/670e180))
* **search:** replace symbol outlines with bounded source excerpts ([d41448d](https://github.com/takara-ai/miru-code/commit/d41448d))
`),
    ).toEqual([
      { title: "Search", description: "replace symbol outlines with bounded source excerpts" },
    ]);
  });

  test("prioritizes features and performance over fixes, retaining at most three", () => {
    expect(
      releaseHighlights(`### Bug Fixes
* **auth:** improve sign-in
### Features
* **plugins:** add a new plugin
* **search:** add a new search mode
### Performance Improvements
* **index:** reduce memory use
`),
    ).toEqual([
      { title: "Plugins", description: "add a new plugin" },
      { title: "Search", description: "add a new search mode" },
      { title: "Index", description: "reduce memory use" },
    ]);
  });

  test("keeps maintenance changes when those are the whole release", () => {
    expect(releaseHighlights("### Miscellaneous Chores\n* **deps:** update dependencies")).toEqual([
      { title: "Deps", description: "update dependencies" },
    ]);
  });

  test("deduplicates changes and strips inline Markdown and PR links", () => {
    expect(
      releaseHighlights(
        "### Features\r\n- support `MCP` in [agents](https://example.com) ([#12](https://example.com/12))\r\n+ support MCP in agents",
      ),
    ).toEqual([{ title: "Features", description: "support MCP in agents" }]);
  });

  test("ignores fenced examples and uses neutral text when notes have no highlights", () => {
    expect(
      releaseHighlights("```md\n* invented change\n```\n[Full changelog](https://example.com)"),
    ).toEqual([{ title: "Release update", description: "See the release notes for details." }]);
  });
});

describe("release card rendering", () => {
  test("reads version and highlights from release JSON, including prereleases", () => {
    expect(parseRelease({ tagName: "v2.0.0-rc.1", body: "* add search", isDraft: false })).toEqual({
      version: "2.0.0-rc.1",
      highlights: [{ title: "Release update", description: "add search" }],
    });
    expect(parseRelease({ tagName: "1.14.4+build.1" }).version).toBe("1.14.4+build.1");
  });

  test("rejects draft releases and tags that could escape the output directory", () => {
    for (const value of [
      null,
      {},
      { tagName: "../../escape" },
      { tagName: "v1.0.0\n" },
      { tagName: "--help" },
    ]) {
      expect(() => parseRelease(value)).toThrow();
    }
    expect(() => parseRelease({ tagName: "v1.0.0", isDraft: true })).toThrow("Publish the release");
  });

  test("wraps long descriptions, truncates with an ellipsis, and splits long identifiers", () => {
    expect(wrapText("one two three four five", 9, 2)).toEqual(["one two", "three…"]);
    expect(wrapText("abcdefghijk", 5, 2)).toEqual(["abcde", "fghi…"]);
    expect(wrapText("", 76, 2)).toEqual([]);
  });

  test("escapes release text, uses the actual version, and preserves the supplied design", () => {
    const svg = buildReleaseCard({
      version: "1.14.4",
      highlights: [{ title: 'Search <&> "quoted"', description: "Support <Paper> & 'authors'" }],
    });
    expect(svg).toContain('width="1200" height="1200"');
    expect(svg).toContain("Miru 1.14.4");
    expect(svg).toContain("Search &lt;&amp;&gt; &quot;quoted&quot;");
    expect(svg).toContain("Support &lt;Paper&gt; &amp; &apos;authors&apos;");
    expect(svg).toContain('fill="#f6f4ef"');
    expect(svg).toContain('fill="#D91009"');
    expect(svg).not.toContain("Miru 1.7.8");
    expect(svg).not.toContain("<Paper>");
  });
});
