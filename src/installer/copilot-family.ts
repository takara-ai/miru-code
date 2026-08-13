/** Agents that share `~/.copilot` hooks and Caveman skill paths. */
export const COPILOT_FAMILY_IDS = ["copilot", "vscode", "visualstudio"] as const;

export type CopilotFamilyId = (typeof COPILOT_FAMILY_IDS)[number];

export function isCopilotFamilyId(id: string): id is CopilotFamilyId {
  return (COPILOT_FAMILY_IDS as readonly string[]).includes(id);
}
