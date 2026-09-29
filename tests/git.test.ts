import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneGitRepository } from "../src/git.ts";

const originalTimeout = process.env.MIRU_CLONE_TIMEOUT;

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.MIRU_CLONE_TIMEOUT;
  else process.env.MIRU_CLONE_TIMEOUT = originalTimeout;
});

describe("cloneGitRepository", () => {
  test("clones a local repository with the requested branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-git-test-"));
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "readme.txt"), "coverage\n");
    const init = Bun.spawn(["git", "-C", source, "init", "-b", "coverage-test"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await init.exited).toBe(0);
    const add = Bun.spawn(["git", "-C", source, "add", "readme.txt"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await add.exited).toBe(0);
    const commit = Bun.spawn(
      [
        "git",
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "test",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await commit.exited).toBe(0);
    const clone = await cloneGitRepository(source, "coverage-test");
    expect((await Bun.file(join(clone, "readme.txt")).text()).replace(/\r\n/g, "\n")).toBe(
      "coverage\n",
    );
    await rm(clone, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("reports a clone failure with stderr", async () => {
    await expect(cloneGitRepository("/path/that/does/not/exist")).rejects.toThrow(
      "git clone failed",
    );
  });

  test("handles spawn errors and timeout results", async () => {
    const missingGit = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof Bun.spawn;
    await expect(cloneGitRepository("example", null, missingGit)).rejects.toThrow(
      "git is not installed",
    );

    const timedOut = (() => ({
      exited: Promise.resolve(1),
      signalCode: "SIGTERM",
      stderr: 1,
    })) as unknown as typeof Bun.spawn;
    await expect(cloneGitRepository("example", null, timedOut)).rejects.toThrow(
      "git clone timed out",
    );

    const noStderr = (() => ({
      exited: Promise.resolve(2),
      signalCode: null,
      stderr: 1,
    })) as unknown as typeof Bun.spawn;
    await expect(cloneGitRepository("example", null, noStderr)).rejects.toThrow(
      "git clone failed for example:\n",
    );
  });
});
