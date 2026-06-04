import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddingApiKey } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";

describe("resolveEmbeddingApiKey", () => {
  test("reads TAKARA_API_KEY", () => {
    const prev = process.env.TAKARA_API_KEY;
    try {
      process.env.TAKARA_API_KEY = "takara-token";
      expect(resolveEmbeddingApiKey()).toBe("takara-token");
    } finally {
      if (prev === undefined) {
        delete process.env.TAKARA_API_KEY;
      } else {
        process.env.TAKARA_API_KEY = prev;
      }
    }
  });

  test("throws when TAKARA_API_KEY is unset", () => {
    const prev = process.env.TAKARA_API_KEY;
    try {
      delete process.env.TAKARA_API_KEY;
      expect(() => resolveEmbeddingApiKey()).toThrow(/Takara API key required/);
    } finally {
      if (prev === undefined) {
        delete process.env.TAKARA_API_KEY;
      } else {
        process.env.TAKARA_API_KEY = prev;
      }
    }
  });
});

describe("loadEnvFiles", () => {
  test("does not override env vars already set by MCP config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "semble-env-"));
    try {
      await writeFile(join(dir, ".env.local"), "TAKARA_API_KEY=file-token\n", "utf-8");
      process.env.TAKARA_API_KEY = "mcp-token";
      loadEnvFiles({ cwd: dir, packageRoot: dir });
      expect(process.env.TAKARA_API_KEY).toBe("mcp-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.TAKARA_API_KEY;
    }
  });
});
