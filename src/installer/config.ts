import { unlink } from "node:fs/promises";
import { type InstallAction, MIRU_BUNX_PACKAGE, MIRU_END, MIRU_START } from "./agents.ts";

const CODEX_MCP_HEADER = "[mcp_servers.miru]";
const CODEX_MCP_BLOCK = `[mcp_servers.miru]
command = "bunx"
args = ["${MIRU_BUNX_PACKAGE}"]
startup_timeout_sec = 60
`;
/** Same Codex block with `--benchmark` preserved across reinstall. */
const CODEX_MCP_BLOCK_BENCHMARK = `[mcp_servers.miru]
command = "bunx"
args = ["${MIRU_BUNX_PACKAGE}", "--benchmark"]
startup_timeout_sec = 60
`;

/** Strip line and block comments so JSONC configs can be parsed. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = '"';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseJsonObject(text: string): Record<string, unknown> | "error" {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(trimmed));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "error";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "error";
  }
}

function sectionObject(
  root: Record<string, unknown>,
  sectionKey: string,
): Record<string, unknown> | "error" {
  let section: unknown = root;
  for (const key of sectionKey.split(".")) {
    if (!section || typeof section !== "object" || Array.isArray(section)) return "error";
    const child = (section as Record<string, unknown>)[key];
    if (child === undefined) return {};
    section = child;
  }
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : "error";
}

export async function mergeJsonMember(
  path: string,
  sectionKey: string,
  memberKey: string,
  value: Record<string, unknown>,
): Promise<InstallAction> {
  const existed = await Bun.file(path).exists();
  const text = existed ? await Bun.file(path).text() : "";
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const section = sectionObject(parsed, sectionKey);
  if (section === "error") {
    return "error";
  }

  if (JSON.stringify(section[memberKey]) === JSON.stringify(value)) {
    return "unchanged";
  }
  const next = upsertJsonMemberText(text, sectionKey, memberKey, value);
  await Bun.write(
    path,
    ensureTrailingNewline(
      next ?? JSON.stringify(withMergedMember(parsed, sectionKey, memberKey, value), null, 2),
    ),
  );
  return existed ? "updated" : "created";
}

export async function removeJsonMember(
  path: string,
  sectionKey: string,
  memberKey: string,
): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) {
    return "not-found";
  }

  const text = await Bun.file(path).text();
  const parsed = parseJsonObject(text);
  if (parsed === "error") {
    return "error";
  }

  const section = sectionObject(parsed, sectionKey);
  if (section === "error" || !(memberKey in section)) {
    return "not-found";
  }
  const nextText = removeJsonMemberText(text, sectionKey, memberKey);
  const nextObject = withRemovedMember(parsed, sectionKey, memberKey);
  let next = nextText ?? JSON.stringify(nextObject, null, 2);
  let nextParsed = parseJsonObject(next);
  if (nextParsed === "error") {
    next = JSON.stringify(nextObject, null, 2);
    nextParsed = parseJsonObject(next);
  }
  if (!nextParsed || typeof nextParsed !== "object" || Object.keys(nextParsed).length === 0) {
    await unlink(path);
    return "removed";
  }
  await Bun.write(path, ensureTrailingNewline(next));
  return "removed";
}

function withMergedMember(
  root: Record<string, unknown>,
  sectionKey: string,
  memberKey: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const keys = sectionKey.split(".");
  const update = (object: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const next = { ...object };
    if (depth === keys.length) {
      next[memberKey] = value;
      return next;
    }
    const key = keys[depth];
    if (!key) return next;
    const child = next[key];
    const section =
      child && typeof child === "object" && !Array.isArray(child)
        ? (child as Record<string, unknown>)
        : {};
    next[key] = update(section, depth + 1);
    return next;
  };
  return update(root, 0);
}

function withRemovedMember(
  root: Record<string, unknown>,
  sectionKey: string,
  memberKey: string,
): Record<string, unknown> {
  const keys = sectionKey.split(".");
  const remove = (
    object: Record<string, unknown>,
    depth: number,
  ): { value: Record<string, unknown>; changed: boolean } => {
    const next = { ...object };
    if (depth === keys.length) {
      if (!(memberKey in next)) return { value: next, changed: false };
      delete next[memberKey];
      return { value: next, changed: true };
    }
    const key = keys[depth];
    const child = key ? next[key] : undefined;
    if (!key || !child || typeof child !== "object" || Array.isArray(child)) {
      return { value: next, changed: false };
    }
    const result = remove(child as Record<string, unknown>, depth + 1);
    if (!result.changed) return { value: next, changed: false };
    if (Object.keys(result.value).length === 0) delete next[key];
    else next[key] = result.value;
    return { value: next, changed: true };
  };
  return remove(root, 0).value;
}

function upsertJsonMemberText(
  text: string,
  sectionKey: string,
  memberKey: string,
  value: Record<string, unknown>,
): string | null {
  if (!hasJsoncSyntax(text)) {
    return null;
  }
  const sectionRange = findSectionRange(text, sectionKey);
  if (!sectionRange) {
    return null;
  }
  const { openBrace, closeBrace, indent } = sectionRange;
  const sectionBody = text.slice(openBrace + 1, closeBrace);
  const memberMatch = new RegExp(`"(${escapeRegExp(memberKey)})"\\s*:`).exec(sectionBody);
  const valueText = JSON.stringify(value);
  if (memberMatch) {
    const memberKeyStart = openBrace + 1 + memberMatch.index;
    const colonIndex = text.indexOf(":", memberKeyStart);
    const valueStart = skipWhitespace(text, colonIndex + 1);
    const valueEnd = parseJsonValueEnd(text, valueStart);
    if (valueEnd <= valueStart) {
      return null;
    }
    return `${text.slice(0, valueStart)} ${valueText}${text.slice(valueEnd)}`;
  }

  const memberIndent = `${indent}  `;
  const insertion = `${sectionBody.trim().length === 0 ? "" : ","}\n${memberIndent}"${memberKey}": ${valueText}\n${indent}`;
  return `${text.slice(0, closeBrace)}${insertion}${text.slice(closeBrace)}`;
}

function removeJsonMemberText(text: string, sectionKey: string, memberKey: string): string | null {
  if (!hasJsoncSyntax(text)) {
    return null;
  }
  const sectionRange = findSectionRange(text, sectionKey);
  if (!sectionRange) {
    return null;
  }
  const { openBrace, closeBrace } = sectionRange;
  const sectionBody = text.slice(openBrace + 1, closeBrace);
  const memberMatch = new RegExp(`"(${escapeRegExp(memberKey)})"\\s*:`).exec(sectionBody);
  if (!memberMatch) {
    return null;
  }
  const memberStart = openBrace + 1 + memberMatch.index;
  const colonIndex = text.indexOf(":", memberStart);
  const valueStart = skipWhitespace(text, colonIndex + 1);
  const valueEnd = parseJsonValueEnd(text, valueStart);
  let removeStart = memberStart;
  let removeEnd = valueEnd;

  const trailing = skipWhitespace(text, valueEnd);
  if (text[trailing] === ",") {
    removeEnd = trailing + 1;
  } else {
    const leadingComma = findLeadingComma(text, memberStart, openBrace + 1);
    if (leadingComma >= 0) {
      removeStart = leadingComma;
    }
  }
  return `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
}

/** True only when // or /* appear outside of strings (URLs like https:// must not match). */
function hasJsoncSyntax(text: string): boolean {
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      return true;
    }
    if (ch === "/" && next === "*") {
      return true;
    }
  }
  return false;
}

/** Locate an object section by dotted path, matching each key among direct children. */
function findSectionRange(
  text: string,
  sectionKey: string,
): { openBrace: number; closeBrace: number; indent: string } | null {
  const keys = sectionKey.split(".");
  let container = text;
  let offset = 0;
  let result: { openBrace: number; closeBrace: number; indent: string } | null = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!key) return null;
    result = findDirectSectionRange(container, key);
    if (!result) return null;
    if (index < keys.length - 1) {
      offset += result.openBrace;
      container = container.slice(result.openBrace, result.closeBrace + 1);
    }
  }
  return result
    ? {
        ...result,
        openBrace: offset + result.openBrace,
        closeBrace: offset + result.closeBrace,
      }
    : null;
}

/** Locate a single child object in a root object, ignoring similarly named nested keys. */
function findDirectSectionRange(
  text: string,
  sectionKey: string,
): { openBrace: number; closeBrace: number; indent: string } | null {
  const keyPrefix = new RegExp(`^"${escapeRegExp(sectionKey)}"\\s*:\\s*\\{`);
  let depth = 0;
  let inString = false;
  let quote = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (depth === 1 && ch === '"') {
      const match = keyPrefix.exec(text.slice(i));
      if (match) {
        const lineStart = text.lastIndexOf("\n", i) + 1;
        const indent = /^[ \t]*/.exec(text.slice(lineStart, i))?.[0] ?? "";
        const openBrace = i + match[0].length - 1;
        const closeBrace = findMatchingBrace(text, openBrace);
        if (closeBrace < 0) {
          return null;
        }
        return { openBrace, closeBrace, indent };
      }
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
    }
  }
  return null;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJsonValueEnd(text: string, start: number): number {
  const first = text[start];
  if (!first) return start;
  if (first === "{") return findMatchingBrace(text, start) + 1;
  if (first === "[") return findMatchingBracket(text, start) + 1;
  if (first === '"' || first === "'") return findStringEnd(text, start) + 1;
  let i = start;
  while (i < text.length && ![",", "}", "]", "\n"].includes(text[i] ?? "")) {
    i++;
  }
  return i;
}

function findMatchingBracket(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findStringEnd(text: string, start: number): number {
  const quote = text[start] ?? '"';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return start;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

function findLeadingComma(text: string, index: number, min: number): number {
  for (let i = index - 1; i >= min; i--) {
    const ch = text[i] ?? "";
    if (ch === ",") return i;
    if (!/\s/.test(ch)) break;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Internal parser helpers exposed for focused edge-case tests. */
export const jsoncTestUtils = {
  hasJsoncSyntax,
  findSectionRange,
  findMatchingBrace,
  parseJsonValueEnd,
  findMatchingBracket,
  findStringEnd,
  skipWhitespace,
  findLeadingComma,
  withRemovedMember,
  upsertJsonMemberText,
  removeJsonMemberText,
};

export async function replaceOrAppendMarked(path: string, content: string): Promise<InstallAction> {
  const existed = await Bun.file(path).exists();
  const existing = existed ? await Bun.file(path).text() : "";

  const startIdx = existing.indexOf(MIRU_START);
  const endIdx = existing.indexOf(MIRU_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MIRU_END.length);
    const updated = `${before}${content.trim()}\n${after.replace(/^\n+/, "")}`;
    if (updated === existing) {
      return "unchanged";
    }
    await Bun.write(path, updated);
    return "updated";
  }

  const separator =
    existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  await Bun.write(path, `${existing}${separator}${content}`);
  return existed ? "updated" : "created";
}

export async function removeMarked(path: string): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) {
    return "not-found";
  }

  const existing = await Bun.file(path).text();
  const startIdx = existing.indexOf(MIRU_START);
  const endIdx = existing.indexOf(MIRU_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return "not-found";
  }

  const before = existing.slice(0, startIdx).replace(/\n+$/, "");
  const after = existing.slice(endIdx + MIRU_END.length).replace(/^\n+/, "");
  const updated = [before, after].filter((part) => part.length > 0).join("\n");
  const withNewline = updated.length > 0 ? `${updated}\n` : "";

  if (withNewline.trim().length === 0) {
    await unlink(path);
    return "removed";
  }

  await Bun.write(path, withNewline);
  return "removed";
}

function stripTomlSection(text: string, header: string): string {
  const prefix = header.trim().slice(1, -1);
  const lines = text.split("\n");
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const tableKey = line.split("#")[0]?.trim() ?? "";
    if (tableKey.startsWith("[") && tableKey.endsWith("]")) {
      const tableName = tableKey.slice(1, -1);
      if (tableName === prefix || tableName.startsWith(`${prefix}.`)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  return result.join("\n");
}

export async function mergeTomlBlock(path: string): Promise<InstallAction> {
  const existed = await Bun.file(path).exists();
  const existing = existed ? await Bun.file(path).text() : "";

  const defaultBlock = CODEX_MCP_BLOCK.trim();
  const benchmarkBlock = CODEX_MCP_BLOCK_BENCHMARK.trim();
  if (existing.includes(defaultBlock) || existing.includes(benchmarkBlock)) {
    return "unchanged";
  }

  const preserveBenchmark =
    existing.includes(CODEX_MCP_HEADER) &&
    (existing.includes('"--benchmark"') || existing.includes("'--benchmark'"));
  const block = preserveBenchmark ? CODEX_MCP_BLOCK_BENCHMARK : CODEX_MCP_BLOCK;

  const base = stripTomlSection(existing, CODEX_MCP_HEADER).replace(/\n+$/, "");
  const next = base.length > 0 ? `${base}\n\n${block}` : block;
  await Bun.write(path, next.endsWith("\n") ? next : `${next}\n`);
  return existed ? "updated" : "created";
}

export async function removeTomlBlock(path: string): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) {
    return "not-found";
  }

  const existing = await Bun.file(path).text();
  if (!existing.includes(CODEX_MCP_HEADER)) {
    return "not-found";
  }

  const remaining = stripTomlSection(existing, CODEX_MCP_HEADER).trim();
  if (remaining.length === 0) {
    await unlink(path);
    return "removed";
  }

  await Bun.write(path, `${remaining}\n`);
  return "removed";
}

/**
 * Ensure Codex loads Agent Skills: `[features] skills = true` in config.toml.
 * Does not disable the flag on uninstall (other skills may still need it).
 */
export function codexSkillsFeatureEnabled(text: string): boolean {
  const lines = text.split("\n");
  let inFeatures = false;
  for (const line of lines) {
    const tableKey = line.split("#")[0]?.trim() ?? "";
    if (tableKey.startsWith("[") && tableKey.endsWith("]")) {
      inFeatures = tableKey === "[features]";
      continue;
    }
    if (!inFeatures) {
      continue;
    }
    const value = line.split("#")[0]?.match(/^\s*skills\s*=\s*(true|false)\s*$/i)?.[1];
    if (value?.toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

export async function ensureCodexSkillsFeature(path: string): Promise<InstallAction> {
  const existed = await Bun.file(path).exists();
  const existing = existed ? await Bun.file(path).text() : "";
  if (codexSkillsFeatureEnabled(existing)) {
    return "unchanged";
  }
  const lines = existing.length > 0 ? existing.split("\n") : [];

  let featuresIdx = -1;
  let skillsIdx = -1;
  let inFeatures = false;

  for (let i = 0; i < lines.length; i++) {
    const tableKey = (lines[i] ?? "").split("#")[0]?.trim() ?? "";
    if (tableKey.startsWith("[") && tableKey.endsWith("]")) {
      if (tableKey === "[features]") {
        inFeatures = true;
        featuresIdx = i;
        continue;
      }
      inFeatures = false;
      continue;
    }
    if (inFeatures && /^\s*skills\s*=/.test(lines[i] ?? "")) {
      skillsIdx = i;
    }
  }

  if (featuresIdx >= 0 && skillsIdx >= 0) {
    lines[skillsIdx] = "skills = true";
    const next = `${lines.join("\n").replace(/\n+$/, "")}\n`;
    await Bun.write(path, next);
    return "updated";
  }

  if (featuresIdx >= 0) {
    lines.splice(featuresIdx + 1, 0, "skills = true");
    const next = `${lines.join("\n").replace(/\n+$/, "")}\n`;
    await Bun.write(path, next);
    return "updated";
  }

  const block = "[features]\nskills = true\n";
  const base = existing.replace(/\n+$/, "");
  const next = base.length > 0 ? `${base}\n\n${block}` : block;
  await Bun.write(path, next.endsWith("\n") ? next : `${next}\n`);
  return existed ? "updated" : "created";
}
