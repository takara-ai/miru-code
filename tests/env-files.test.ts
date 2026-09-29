import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "../src/env-files.ts";

const roots: string[] = [];
const keys = ["MIRU_COVERAGE_ENV_FIRST", "MIRU_COVERAGE_ENV_SECOND", "MIRU_COVERAGE_ENV_EXISTING"];
const originals = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "miru-env-test-"));
  roots.push(root);
  return root;
}

describe("loadEnvFiles", () => {
  test("loads package and cwd dotenv files in precedence order without replacing existing values", async () => {
    const packageRoot = await tempRoot();
    const cwd = await tempRoot();
    process.env.MIRU_COVERAGE_ENV_EXISTING = "provided";
    await writeFile(
      join(packageRoot, ".env.local"),
      "# comment\n\nMIRU_COVERAGE_ENV_FIRST='package local'\ninvalid\n=empty\nMIRU_COVERAGE_ENV_EXISTING=file\n",
    );
    await writeFile(join(packageRoot, ".env"), "MIRU_COVERAGE_ENV_FIRST=package env\n");
    await writeFile(join(cwd, ".env.local"), "MIRU_COVERAGE_ENV_SECOND=from cwd\n");

    await loadEnvFiles({ packageRoot, cwd });
    expect(process.env.MIRU_COVERAGE_ENV_FIRST).toBe("package local");
    expect(process.env.MIRU_COVERAGE_ENV_SECOND).toBe("from cwd");
    expect(process.env.MIRU_COVERAGE_ENV_EXISTING).toBe("provided");
  });

  test("tolerates missing dotenv files", async () => {
    await loadEnvFiles({ packageRoot: await tempRoot(), cwd: await tempRoot() });
  });
});
