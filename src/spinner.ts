import { dim, green, red } from "./cli-ui.ts";
import { displayWidth } from "./terminal.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private belowLines = 0;

  constructor(
    private readonly message: string,
    private readonly stderr: SpinnerOutput = process.stderr,
  ) {}

  start(): void {
    if (!this.stderr.isTTY) {
      this.stderr.write(`${this.message}...\n`);
      return;
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
  }

  follow(line: string): void {
    if (!this.stderr.isTTY) {
      this.stderr.write(`${line}\n`);
      return;
    }
    const cols = this.stderr.columns || 80;
    const rows = line.split("\n").reduce((count, part) => {
      return count + Math.max(1, Math.ceil(displayWidth(part) / cols));
    }, 0);
    this.stderr.write(`\n${line}`);
    this.belowLines += rows;
    this.stderr.write(`\x1b[${this.belowLines}A`);
  }

  stop(finalMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stderr.isTTY) {
      this.stderr.write("\r\x1b[K");
      if (finalMessage) {
        this.stderr.write(finalMessage);
      }
      if (this.belowLines > 0) {
        this.stderr.write(`\x1b[${this.belowLines}B`);
      }
      if (finalMessage || this.belowLines > 0) {
        this.stderr.write("\n");
      }
    } else if (finalMessage) {
      this.stderr.write(`${finalMessage}\n`);
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

  private draw(): void {
    const glyph = FRAMES[this.frame++ % FRAMES.length];
    this.stderr.write(`\r${dim(glyph)} ${this.message}`);
  }
}

interface SpinnerOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  options?: { successMessage?: string; failMessage?: string },
  output: SpinnerOutput = process.stderr,
): Promise<T> {
  const spinner = new Spinner(message, output);
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
