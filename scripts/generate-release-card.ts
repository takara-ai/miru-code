import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export interface ReleaseCard {
  version: string;
  highlights: Array<{ title: string; description: string }>;
}

const MAINTENANCE_SCOPE =
  /^(?:build|chore|ci|coverage|deps(?:-dev)?|docs|lint|release|test|tests)$/i;

function plainText(value: string): string {
  return value
    .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/gi, "")
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+|\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer user-facing changes, preserving the release notes' order within each category. */
export function releaseHighlights(body: string): ReleaseCard["highlights"] {
  let section = "Release update";
  let fenced = false;
  const changes: Array<ReleaseCard["highlights"][number] & { priority: number }> = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    if (heading) {
      section = plainText(heading[1] ?? "");
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const scoped = /^\*\*([^*]+?):\*\*\s*(.+)$/.exec(bullet[1] ?? "");
    const scope = scoped?.[1] ?? "";
    const description = plainText(scoped?.[2] ?? bullet[1] ?? "");
    if (!description) continue;
    const maintenance =
      MAINTENANCE_SCOPE.test(scope) || /chore|build|dependenc|documentation/i.test(section);
    const priority = maintenance
      ? 3
      : /feature|security|breaking/i.test(section)
        ? 0
        : /performance/i.test(section)
          ? 1
          : 2;
    const title = scope ? scope[0]?.toUpperCase() + scope.slice(1) : section;
    changes.push({ title, description, priority });
  }
  const userFacing = changes.filter((change) => change.priority < 3);
  const candidates = userFacing.length ? userFacing : changes;
  const seen = new Set<string>();
  const highlights = candidates
    .sort((a, b) => a.priority - b.priority)
    .filter(({ description }) => {
      const key = description.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map(({ title, description }) => ({ title, description }));
  return highlights.length
    ? highlights
    : [{ title: "Release update", description: "See the release notes for details." }];
}

export function parseRelease(value: unknown): ReleaseCard {
  const release = value as { tagName?: unknown; body?: unknown; isDraft?: unknown } | null;
  if (
    !release ||
    typeof release.tagName !== "string" ||
    !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(release.tagName) ||
    release.tagName.trim() !== release.tagName
  ) {
    throw new Error("Expected a release JSON object with a semantic-version tagName.");
  }
  if (release.isDraft) throw new Error("Publish the release before generating its card.");
  return {
    version: release.tagName.replace(/^v/, ""),
    highlights: releaseHighlights(typeof release.body === "string" ? release.body : ""),
  };
}

export function wrapText(value: string, width: number, maxLines: number): string[] {
  const remaining = plainText(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  while (remaining.length && lines.length < maxLines) {
    let line = "";
    while (
      remaining.length &&
      (line.length === 0 || line.length + 1 + (remaining[0]?.length ?? 0) <= width)
    ) {
      const word = remaining.shift() ?? "";
      if (word.length > width) {
        line = word.slice(0, width);
        remaining.unshift(word.slice(width));
        break;
      }
      line += `${line ? " " : ""}${word}`;
    }
    if (lines.length === maxLines - 1 && remaining.length)
      line = `${line.slice(0, width - 1).trimEnd()}…`;
    lines.push(line);
  }
  return lines;
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char,
  );
}

export function buildReleaseCard(card: ReleaseCard): string {
  const rows = card.highlights
    .map((highlight, index) => {
      const y = 120 + index * 110;
      const description = wrapText(highlight.description, 76, 2)
        .map(
          (line, lineIndex) =>
            `<text x="74" y="${y + 34 + lineIndex * 25}" fill="#ffffff" fill-opacity=".68" font-size="19">${xml(line)}</text>`,
        )
        .join("\n");
      return `<text x="43" y="${y}" fill="#D91009">✦</text>
      <text x="74" y="${y}" fill="#ffffff" fill-opacity=".9" font-weight="700">${xml(wrapText(highlight.title, 52, 1)[0] ?? "")}</text>
      ${description}`;
    })
    .join("\n");
  const title = `Miru ${card.version}`;
  const titleSize = Math.min(104, Math.floor(1550 / title.length));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-labelledby="title description">
  <title id="title">${xml(title)} — release highlights</title>
  <desc id="description">${xml(card.highlights.map((highlight) => `${highlight.title}: ${highlight.description}`).join(". "))}</desc>
  <defs>
    <pattern id="grain" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".45" fill="#151515" opacity=".11"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="25" stdDeviation="24" flood-color="#20120f" flood-opacity=".22"/></filter>
    <filter id="ray-blur" x="-120" y="-120" width="1240" height="1240" filterUnits="userSpaceOnUse"><feGaussianBlur in="SourceGraphic" stdDeviation="33"/></filter>
    <style>.sans{font-family:Arial,"Liberation Sans",sans-serif}.mono{font-family:Menlo,"Liberation Mono",monospace}</style>
  </defs>
  <rect width="1200" height="1200" fill="#f6f4ef"/>
  <rect width="1200" height="1200" fill="url(#grain)"/>
  <g fill="#D91009" filter="url(#ray-blur)">
    <path d="M495.882 996.38 478.558 442.275 504.119 3.6204 538.364 435.455Z" opacity=".24" transform="translate(890 1000) rotate(45) scale(.72) translate(-500 -500)"/>
    <path d="M495.882 996.38 478.558 442.275 504.119 3.6204 538.364 435.455Z" opacity=".14" transform="translate(80 1120) rotate(45) scale(.48) translate(-500 -500)"/>
  </g>
  <path d="M0 165H1200M0 1035H1200" stroke="#e1ddd4"/>
  <g transform="translate(71 67)">
    <g transform="scale(.079)" fill="#D91009">
      <path d="M266.642 292.456 476.421 355.055 428.39 490.987 31.5294 660.868 148.083 331.685 237.792 287.702Z"/>
      <path d="m798.675 237.34 52.269 110.058-92.342-91.333-238.338 234.896-53.068-43.763 28.552-80.806 21.747 18.123 65.482-48.548 157.517-116.297Z"/>
      <path d="m548.776 278.522 14.709 44.509-45.196 33.507-19.248-16.039-103.7-166.238Z"/>
      <path d="m465.914 328.961-179.942-53.696 72.551-118.457Z"/>
      <path d="m276.163 249.156-12.556 20.503-29.182-4.808-26.936 13.205L0 13.2754Z"/>
      <path d="m628.097 217.461-69.63 41.046-141.59-96.21L689.535 0Z"/>
    </g>
    <text x="82" y="43" class="sans" fill="#171717" font-size="31" font-weight="700" letter-spacing="-1.3">takara.ai</text>
  </g>
  <g transform="translate(70 246)">
    <text class="mono" fill="#D91009" font-size="20" font-weight="700" letter-spacing="2.8">AGENTIC CODE SEARCH</text>
    <text y="104" class="sans" fill="#171717" font-size="${titleSize}" font-weight="730" letter-spacing="-4">${xml(title)}</text>
    <text y="164" class="sans" fill="#55514b" font-size="38" font-weight="600" letter-spacing="-1.1">What&apos;s new?</text>
  </g>
  <g transform="translate(70 505)" filter="url(#shadow)">
    <rect width="1060" height="435" rx="11" fill="#131313"/>
    <path d="M11 0H1049Q1060 0 1060 11V64H0V11Q0 0 11 0" fill="#1a1a1a"/>
    <path d="M0 64H1060" stroke="#ffffff" stroke-opacity=".1"/>
    <circle cx="35" cy="32" r="5" fill="#ffffff" fill-opacity=".15"/><circle cx="53" cy="32" r="5" fill="#ffffff" fill-opacity=".15"/><circle cx="71" cy="32" r="5" fill="#ffffff" fill-opacity=".15"/>
    <text x="94" y="38" class="mono" fill="#ffffff" fill-opacity=".6" font-size="16">miru — release notes</text>
    <g class="mono" font-size="23">${rows}</g>
  </g>
  <text x="70" y="1090" class="mono" font-size="20" fill="#55514b">github.com/takara-ai/miru-code</text>
</svg>\n`;
}

export async function generateReleaseCard(release: unknown, outputDir: string): Promise<string[]> {
  const card = parseRelease(release);
  const basename = resolve(outputDir, `miru-${card.version}-release`);
  await mkdir(outputDir, { recursive: true });
  await Bun.write(`${basename}.svg`, buildReleaseCard(card));
  const renderer = Bun.spawn(
    ["rsvg-convert", "--output", `${basename}.png`, "--format", "png", `${basename}.svg`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(renderer.stderr).text();
  if ((await renderer.exited) !== 0) throw new Error(`rsvg-convert failed: ${error}`);
  return [`${basename}.svg`, `${basename}.png`];
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "release-json": { type: "string" },
      "out-dir": { type: "string", default: "dist/release-card" },
    },
  });
  if (!values["release-json"])
    throw new Error(
      "Usage: bun scripts/generate-release-card.ts --release-json release.json [--out-dir dist/release-card]",
    );
  const paths = await generateReleaseCard(
    await Bun.file(values["release-json"]).json(),
    resolve(values["out-dir"]),
  );
  console.log(`Generated:\n${paths.join("\n")}`);
}
