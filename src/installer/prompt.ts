import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { bold, cyan, dim, divider, hint, warn } from "../cli-ui.ts";

export function requireInteractiveTerminal(command: string): void {
  if (!input.isTTY) {
    throw new Error(
      `${command} requires an interactive terminal. Configure agents manually (see README) ` +
        "or run from a TTY.",
    );
  }
}

async function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  const hintText = defaultYes ? dim("[Y/n]") : dim("[y/N]");
  const answer = (await readLine(`${question} ${hintText} `)).toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  return answer === "y" || answer === "yes";
}

export async function promptMultiSelect<T>(
  title: string,
  items: Array<{ label: string; value: T; checked: boolean }>,
): Promise<T[] | null> {
  output.write("\n");
  output.write(`${bold(title)}\n`);
  divider("─", 48, output);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const mark = item.checked ? cyan("[x]") : dim("[ ]");
    output.write(`  ${dim(String(i + 1).padStart(2))}. ${mark} ${item.label}\n`);
  }

  output.write("\n");
  hint("Enter numbers (1,3), 'all', or press Enter for defaults", output);

  const answer = (await readLine(`${dim("> ")}`)).toLowerCase();
  if (!answer) {
    return items.filter((item) => item.checked).map((item) => item.value);
  }
  if (answer === "all" || answer === "a") {
    return items.map((item) => item.value);
  }

  const indices = new Set<number>();
  for (const part of answer.split(/[,\s]+/)) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) {
      indices.add(n - 1);
    }
  }

  if (indices.size === 0) {
    warn("No valid selection.", output);
    return null;
  }

  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => items[i]?.value)
    .filter((value): value is T => value !== undefined);
}
