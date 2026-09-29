import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

export interface HiddenPromptState {
  value: string;
  escapeBuffer: string;
}

export function createHiddenPromptState(): HiddenPromptState {
  return { value: "", escapeBuffer: "" };
}

/** Apply one UTF-16 code unit from raw stdin; returns terminal echo bytes (may be empty). */
export function applyHiddenPromptChar(
  state: HiddenPromptState,
  char: string,
): { state: HiddenPromptState; echo: string; submit?: boolean; cancel?: boolean } {
  if (char === "\x1b") {
    return { state: { ...state, escapeBuffer: "\x1b" }, echo: "" };
  }

  if (state.escapeBuffer.length > 0) {
    const escapeBuffer = state.escapeBuffer + char;
    let done = false;
    if (escapeBuffer.startsWith("\x1b[")) {
      done = escapeBuffer.length > 2 && char >= "@" && char <= "~";
    } else if (escapeBuffer.startsWith("\x1b")) {
      done = escapeBuffer.length >= 2;
    }
    return {
      state: { ...state, escapeBuffer: done ? "" : escapeBuffer },
      echo: "",
    };
  }

  if (char === "\n" || char === "\r" || char === "\u0004") {
    return { state, echo: "", submit: true };
  }

  if (char === "\u0003") {
    return { state, echo: "", cancel: true };
  }

  if (char === "\u007f" || char === "\b") {
    if (state.value.length === 0) {
      return { state, echo: "" };
    }
    return {
      state: { ...state, value: state.value.slice(0, -1) },
      echo: "\b \b",
    };
  }

  if (char < " " || char === "\x7f") {
    return { state, echo: "" };
  }

  return {
    state: { ...state, value: state.value + char },
    echo: "*",
  };
}

/** Visible-input prompt (not for secrets — use promptHidden for those). */
export async function promptText(
  message: string,
  defaultValue = "",
  createInterface: typeof createPromptInterface = createPromptInterface,
): Promise<string> {
  const rl = createInterface({ input, output });
  return promptTextWith(
    message,
    defaultValue,
    (question) => rl.question(question),
    () => rl.close(),
  );
}

export function createPromptInterface(
  options: { input: typeof input; output: typeof output },
  factory: typeof readline.createInterface = readline.createInterface,
): Pick<readline.Interface, "question" | "close"> {
  return factory(options);
}

export async function promptTextWith(
  message: string,
  defaultValue: string,
  ask: (question: string) => Promise<string>,
  close: () => void = () => {},
): Promise<string> {
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await ask(`${message}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    close();
  }
}

export async function promptHidden(
  message: string,
  stream: { write(text: string): unknown } = output,
  io: { input?: HiddenPromptInput; exit?: (code: number) => void } = {},
): Promise<string> {
  const inputStream = io.input ?? input;
  if (!inputStream.isTTY) {
    throw new Error(
      "Cannot prompt for API key: stdin is not a TTY. Run `miru setup --key YOUR_KEY` or set TAKARA_API_KEY.",
    );
  }

  return new Promise((resolve, reject) => {
    stream.write(message);
    inputStream.setRawMode?.(true);
    inputStream.resume();
    inputStream.setEncoding("utf8");

    let state = createHiddenPromptState();

    const onData = (chunk: string) => {
      for (const char of chunk) {
        const result = applyHiddenPromptChar(state, char);
        state = result.state;

        if (result.cancel) {
          cleanup();
          stream.write("\n");
          reject(new Error("Setup cancelled."));
          (io.exit ?? process.exit)(130);
        }

        if (result.submit) {
          cleanup();
          stream.write("\n");
          resolve(state.value.trim());
          return;
        }

        if (result.echo) {
          stream.write(result.echo);
        }
      }
    };

    const cleanup = () => {
      inputStream.setRawMode?.(false);
      inputStream.pause();
      inputStream.removeListener("data", onData);
    };

    inputStream.on("data", onData);
  });
}

interface HiddenPromptInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  removeListener(event: "data", listener: (chunk: string) => void): unknown;
}
