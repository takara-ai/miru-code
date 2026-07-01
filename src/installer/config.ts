import { unlink } from "node:fs/promises";
import { type InstallAction, MIRU_END, MIRU_START } from "./agents.ts";

const CODEX_MCP_HEADER = "[mcp_servers.miru]";
const CODEX_MCP_BLOCK = `[mcp_servers.miru]
command = "bunx"
args = ["@takara-ai/miru-code"]
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
  const section = root[sectionKey];
  if (section === undefined) {
    return {};
  }
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return "error";
  }
  return section as Record<string, unknown>;
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

  section[memberKey] = value;
  parsed[sectionKey] = section;

  const next = `${JSON.stringify(parsed, null, 2)}\n`;

  await Bun.write(path, next);
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

  delete section[memberKey];
  if (Object.keys(section).length === 0) {
    delete parsed[sectionKey];
  } else {
    parsed[sectionKey] = section;
  }

  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  if (next === `${text.endsWith("\n") ? text : `${text}\n`}`) {
    return "not-found";
  }

  if (Object.keys(parsed).length === 0) {
    await unlink(path);
    return "removed";
  }

  await Bun.write(path, next);
  return "removed";
}

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

  if (existing.includes(CODEX_MCP_BLOCK.trim())) {
    return "unchanged";
  }

  const base = stripTomlSection(existing, CODEX_MCP_HEADER).replace(/\n+$/, "");
  const next = base.length > 0 ? `${base}\n\n${CODEX_MCP_BLOCK}` : CODEX_MCP_BLOCK;
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
