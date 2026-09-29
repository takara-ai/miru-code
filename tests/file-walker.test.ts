import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "../src/index/file-walker.ts";

describe("walkFiles", () => {
  test("respects nested ignore files, default ignored directories, and file extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-walk-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "ignored-dir"));
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "ignored-dir/\nsecret.ts\n");
      await writeFile(join(root, ".miruignore"), "*.spec.ts\n");
      await writeFile(join(root, "src", ".gitignore"), "local.ts\n");
      await writeFile(join(root, "src", "main.TS"), "");
      await writeFile(join(root, "src", "local.ts"), "");
      await writeFile(join(root, "src", "unit.spec.ts"), "");
      await writeFile(join(root, "Dockerfile"), "");
      await writeFile(join(root, "secret.ts"), "");
      await writeFile(join(root, "ignored-dir", "hidden.ts"), "");
      await writeFile(join(root, "node_modules", "pkg", "hidden.ts"), "");
      await writeFile(join(root, "README"), "");
      await symlink(join(root, "Dockerfile"), join(root, "docker-link"));

      const files: string[] = [];
      for await (const path of walkFiles(root, [".ts"])) files.push(path);
      expect(files.sort()).toEqual([join(root, "Dockerfile"), join(root, "src", "main.TS")].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("silently handles missing roots and empty ignore files", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-walk-"));
    try {
      await writeFile(join(root, ".gitignore"), "\n");
      await writeFile(join(root, "plain"), "");
      const found: string[] = [];
      for await (const path of walkFiles(root, [])) found.push(path);
      expect(found).toEqual([]);
      const missing: string[] = [];
      for await (const path of walkFiles(join(root, "missing"), [".ts"])) missing.push(path);
      expect(missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
