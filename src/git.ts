import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envOptionalInt } from "./env.ts";

const DEFAULT_CLONE_TIMEOUT_SEC = 60;

export async function cloneGitRepository(url: string, ref?: string | null): Promise<string> {
  const timeoutSec = envOptionalInt(["MIRU_CLONE_TIMEOUT"], 1) ?? DEFAULT_CLONE_TIMEOUT_SEC;
  const dir = await mkdtemp(join(tmpdir(), "miru-git-"));
  const args = ["clone", "--depth", "1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push("--", url, dir);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw new Error("git is not installed or not on PATH");
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutSec * 1000);

  const code = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`git clone timed out for ${url} (limit: ${timeoutSec}s)`);
  }

  if (code !== 0) {
    const stderr =
      proc.stderr && typeof proc.stderr !== "number" ? await new Response(proc.stderr).text() : "";
    await rm(dir, { recursive: true, force: true });
    throw new Error(`git clone failed for ${url}:\n${stderr.trim()}`);
  }

  return dir;
}
