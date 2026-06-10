import { dim, green, red } from "./cli-ui.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(private readonly message: string) {}

  start(): void {
    if (!process.stderr.isTTY) {
      process.stderr.write(`${this.message}...\n`);
      return;
    }
    this.timer = setInterval(() => {
      const glyph = FRAMES[this.frame++ % FRAMES.length];
      process.stderr.write(`\r${dim(glyph)} ${this.message}`);
    }, 80);
  }

  stop(finalMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stderr.isTTY) {
      process.stderr.write("\r\x1b[K");
    }
    if (finalMessage) {
      process.stderr.write(`${finalMessage}\n`);
    }
  }

  succeed(message?: string): void {
    if (message === "") {
      this.stop();
      return;
    }
    this.stop(green("✓ ") + (message ?? this.message));
  }

  fail(message?: string): void {
    this.stop(red("✗ ") + (message ?? this.message));
  }
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  options?: { successMessage?: string; failMessage?: string },
): Promise<T> {
  const spinner = new Spinner(message);
  spinner.start();
  try {
    const result = await fn();
    spinner.succeed(options?.successMessage ?? "");
    return result;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
