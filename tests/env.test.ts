import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddingApiKey } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";

describe("resolveEmbeddingApiKey", () => {
  test("prefers MCP-style env vars in priority order", () => {
    const prev = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      SEMBLE_OPENAI_API_KEY: process.env.SEMBLE_OPENAI_API_KEY,
      TAKARA_API_KEY: process.env.TAKARA_API_KEY,
    };
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.SEMBLE_OPENAI_API_KEY;
      process.env.TAKARA_API_KEY = "takara-token";
      expect(resolveEmbeddingApiKey()).toBe("takara-token");

      delete process.env.TAKARA_API_KEY;
      process.env.OPENAI_API_KEY = "openai-token";
      expect(resolveEmbeddingApiKey()).toBe("openai-token");
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
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
