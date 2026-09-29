import { unlink } from "node:fs/promises";
import type { InstallAction, LegacyHooksFormat } from "./agents.ts";
import { stripJsonComments } from "./config.ts";
import { isCopilotFamilyId } from "./copilot-family.ts";

const LEGACY_MARKERS = ["hook-guard", "miru-search"];
const VSCODE_OWNERS_KEY = "miruOwners";

function isLegacyCommand(value: unknown): boolean {
  return typeof value === "string" && LEGACY_MARKERS.some((marker) => value.includes(marker));
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripJsonComments(text));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyMiruConfig(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data);
  if (keys.length === 0 || keys.every((key) => key === "version")) return true;
  const hooks = object(data.hooks);
  return (
    !!hooks &&
    Object.keys(data).every((key) => key === "version" || key === "hooks") &&
    Object.keys(hooks).length === 0
  );
}

async function writeResult(path: string, data: Record<string, unknown>): Promise<void> {
  if (hasOnlyMiruConfig(data)) {
    await unlink(path);
  } else {
    await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function isMiruEntry(format: LegacyHooksFormat, entry: Record<string, unknown>): boolean {
  if (format === "claude") {
    const nested = Array.isArray(entry.hooks) ? entry.hooks : [];
    return nested.some((hook) => isLegacyCommand(object(hook)?.command));
  }
  return isLegacyCommand(entry.command);
}

/** Remove search hooks installed by older Miru releases; Miru no longer installs hooks. */
export async function removeLegacySearchHooks(
  format: LegacyHooksFormat,
  path: string,
  owner?: string,
): Promise<InstallAction> {
  if (!(await Bun.file(path).exists())) return "not-found";

  if (format === "opencode") {
    await unlink(path);
    return "removed";
  }

  const text = await Bun.file(path).text();
  const data = parseObject(text);
  if (!data) return "error";

  const hooks = object(data.hooks);

  let ownerChanged = false;
  if (format === "vscode") {
    const owners = Array.isArray(data[VSCODE_OWNERS_KEY])
      ? (data[VSCODE_OWNERS_KEY] as unknown[]).filter(
          (value): value is string => typeof value === "string" && isCopilotFamilyId(value),
        )
      : null;
    if (owners && owner) {
      const remaining = owners.filter((value) => value !== owner);
      if (remaining.length > 0) {
        data[VSCODE_OWNERS_KEY] = remaining;
        await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
        return "updated";
      }
      delete data[VSCODE_OWNERS_KEY];
      ownerChanged = true;
    }
  }

  if (!hooks) {
    if (!ownerChanged) return "not-found";
    await writeResult(path, data);
    return "removed";
  }

  const eventKey = {
    claude: "PreToolUse",
    cursor: "preToolUse",
    gemini: "BeforeTool",
    vscode: "PreToolUse",
    kiro: "preToolUse",
    windsurf: "pre_run_command",
    opencode: "",
  }[format];
  const entries = Array.isArray(hooks[eventKey]) ? (hooks[eventKey] as unknown[]) : null;
  if (!entries) {
    if (!ownerChanged) return "not-found";
    await writeResult(path, data);
    return "removed";
  }

  const retained = entries.filter((entry) => {
    const record = object(entry);
    return !record || !isMiruEntry(format, record);
  });
  if (retained.length === entries.length) {
    if (!ownerChanged) return "not-found";
    await writeResult(path, data);
    return "removed";
  }
  if (retained.length === 0) delete hooks[eventKey];
  else hooks[eventKey] = retained;
  if (Object.keys(hooks).length === 0) delete data.hooks;
  await writeResult(path, data);
  return "removed";
}
