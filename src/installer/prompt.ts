import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { bold, cyan, dim, divider, green, hint, warn } from "../cli-ui.ts";

export function requireInteractiveTerminal(command: string): void {
  if (!input.isTTY) {
    throw new Error(
      `${command} requires an interactive terminal. Configure agents manually (see README) ` +
        "or run from a TTY.",
    );
  }
}

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const CURSOR_START = `${ESC}[G`;

function writeRaw(text: string): void {
  output.write(text);
}

function moveCursorUp(lines: number): void {
  if (lines > 0) {
    writeRaw(`${ESC}[${lines}A`);
  }
}

function moveCursorDown(lines: number): void {
  if (lines > 0) {
    writeRaw(`${ESC}[${lines}B`);
  }
}

function rewriteLineAtOffsetFromBottom(offsetFromBottom: number, content: string): void {
  moveCursorUp(offsetFromBottom);
  writeRaw(`${CURSOR_START}${CLEAR_LINE}${content}`);
  moveCursorDown(offsetFromBottom);
}

const MULTI_SELECT_HEADER_LINES = 3;
const MULTI_SELECT_TRAILER_LINES = 2;

function multiSelectTotalLines(itemCount: number): number {
  return MULTI_SELECT_HEADER_LINES + itemCount + MULTI_SELECT_TRAILER_LINES;
}

function multiSelectItemOffsetFromBottom(itemIndex: number, itemCount: number): number {
  return multiSelectTotalLines(itemCount) - (MULTI_SELECT_HEADER_LINES + itemIndex);
}

function formatMultiSelectItemLine(
  item: { label: string; checked: boolean },
  selected: boolean,
): string {
  const pointer = selected ? cyan("›") : " ";
  const mark = item.checked ? cyan("[x]") : dim("[ ]");
  const label = selected ? bold(item.label) : item.label;
  return `  ${pointer} ${mark} ${label}`;
}

function updateMultiSelectItemRow(
  item: { label: string; checked: boolean },
  itemIndex: number,
  itemCount: number,
  selected: boolean,
): void {
  rewriteLineAtOffsetFromBottom(
    multiSelectItemOffsetFromBottom(itemIndex, itemCount),
    formatMultiSelectItemLine(item, selected),
  );
}

function readKey(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
    };
    input.once("data", onData);
    input.once("error", onError);
  });
}

function parseKey(chunk: Buffer): string {
  const text = chunk.toString("utf8");
  if (chunk.length >= 3 && chunk[0] === 0x1b && chunk[1] === 0x5b) {
    const code = chunk[2];
    if (code === 0x41) {
      return "up";
    }
    if (code === 0x42) {
      return "down";
    }
    if (code === 0x43) {
      return "right";
    }
    if (code === 0x44) {
      return "left";
    }
  }
  if (text === "\r" || text === "\n") {
    return "enter";
  }
  if (text === " ") {
    return "space";
  }
  if (text === "\x03") {
    return "ctrl-c";
  }
  if (text === "a" || text === "A") {
    return "all";
  }
  if (text === "y" || text === "Y") {
    return "yes";
  }
  if (text === "n" || text === "N") {
    return "no";
  }
  return text;
}

async function withRawMode<T>(fn: () => Promise<T>): Promise<T> {
  input.setRawMode(true);
  input.resume();
  writeRaw(HIDE_CURSOR);
  try {
    return await fn();
  } finally {
    writeRaw(SHOW_CURSOR);
    input.setRawMode(false);
    input.pause();
  }
}

function buildMultiSelectLines<T>(
  title: string,
  items: Array<{ label: string; value: T; checked: boolean }>,
  cursor: number,
  footer: string,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(bold(title));
  lines.push(dim("─".repeat(48)));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    lines.push(formatMultiSelectItemLine(item, i === cursor));
  }
  lines.push("");
  lines.push(dim(footer));
  return lines;
}

export async function promptMultiSelect<T>(
  title: string,
  items: Array<{ label: string; value: T; checked: boolean }>,
): Promise<T[] | null> {
  if (items.length === 0) {
    return [];
  }

  if (!input.isTTY) {
    return items.filter((item) => item.checked).map((item) => item.value);
  }

  const footer = "↑↓ move  space toggle  a all  enter confirm  ctrl-c cancel";
  let cursor = 0;
  const itemCount = items.length;

  return withRawMode(async () => {
    writeRaw(`${buildMultiSelectLines(title, items, cursor, footer).join("\n")}\n`);

    while (true) {
      const key = parseKey(await readKey());

      if (key === "ctrl-c") {
        writeRaw("\n");
        return null;
      }
      if (key === "enter") {
        writeRaw("\n");
        return items.filter((item) => item.checked).map((item) => item.value);
      }
      if (key === "up") {
        if (cursor > 0) {
          const previous = cursor;
          cursor--;
          const previousItem = items[previous];
          const currentItem = items[cursor];
          if (previousItem) {
            updateMultiSelectItemRow(previousItem, previous, itemCount, false);
          }
          if (currentItem) {
            updateMultiSelectItemRow(currentItem, cursor, itemCount, true);
          }
        }
      } else if (key === "down") {
        if (cursor < items.length - 1) {
          const previous = cursor;
          cursor++;
          const previousItem = items[previous];
          const currentItem = items[cursor];
          if (previousItem) {
            updateMultiSelectItemRow(previousItem, previous, itemCount, false);
          }
          if (currentItem) {
            updateMultiSelectItemRow(currentItem, cursor, itemCount, true);
          }
        }
      } else if (key === "space") {
        const item = items[cursor];
        if (item) {
          item.checked = !item.checked;
          updateMultiSelectItemRow(item, cursor, itemCount, true);
        }
      } else if (key === "all") {
        const allChecked = items.every((item) => item.checked);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item) {
            continue;
          }
          item.checked = !allChecked;
          updateMultiSelectItemRow(item, i, itemCount, i === cursor);
        }
      }
    }
  });
}

function buildConfirmPromptLine(question: string, yesSelected: boolean): string {
  const yes = yesSelected ? green(bold(" Yes ")) : dim(" Yes ");
  const no = yesSelected ? dim(" No ") : green(bold(" No "));
  return `${question}  ${yes} / ${no}`;
}

function buildConfirmLines(question: string, yesSelected: boolean): string[] {
  return [
    buildConfirmPromptLine(question, yesSelected),
    dim("←→ or y/n to choose  enter to confirm  ctrl-c to cancel"),
  ];
}

const CONFIRM_PROMPT_LINES = 2;

function updateConfirmPromptLine(question: string, yesSelected: boolean): void {
  rewriteLineAtOffsetFromBottom(
    CONFIRM_PROMPT_LINES,
    buildConfirmPromptLine(question, yesSelected),
  );
}

export async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const hintText = defaultYes ? dim("[Y/n]") : dim("[y/N]");
      const answer = (await rl.question(`${question} ${hintText} `)).trim().toLowerCase();
      if (!answer) {
        return defaultYes;
      }
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }

  let yesSelected = defaultYes;

  return withRawMode(async () => {
    writeRaw(`${buildConfirmLines(question, yesSelected).join("\n")}\n`);

    while (true) {
      const key = parseKey(await readKey());

      if (key === "ctrl-c") {
        writeRaw("\n");
        return false;
      }
      if (key === "enter") {
        writeRaw("\n");
        return yesSelected;
      }
      if (key === "left" || key === "no") {
        if (yesSelected) {
          yesSelected = false;
          updateConfirmPromptLine(question, yesSelected);
        }
      } else if (key === "right" || key === "yes") {
        if (!yesSelected) {
          yesSelected = true;
          updateConfirmPromptLine(question, yesSelected);
        }
      }
    }
  });
}

/** Legacy numbered prompt kept for non-TTY fallback in tests. */
export async function promptMultiSelectLegacy<T>(
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

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`${dim("> ")}`)).toLowerCase();
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
  } finally {
    rl.close();
  }
}
