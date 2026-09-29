import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envFirstString,
  envInt,
  envOptionalInt,
  hasTakaraApiKeyInEnv,
  isUsableTakaraApiKey,
  normalizeTakaraApiKeyEnv,
  resolveEmbeddingApiKey,
} from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { searchImprovementsEnabled } from "../src/ranking/features.ts";

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
      expect(() => resolveEmbeddingApiKey()).toThrow(/Takara credentials required/);
    } finally {
      if (prev === undefined) {
        delete process.env.TAKARA_API_KEY;
      } else {
        process.env.TAKARA_API_KEY = prev;
      }
    }
  });

  test("treats MCP placeholder env as unset", () => {
    const prev = process.env.TAKARA_API_KEY;
    try {
      process.env.TAKARA_API_KEY = "$" + "{TAKARA_API_KEY}";
      expect(isUsableTakaraApiKey(process.env.TAKARA_API_KEY)).toBe(false);
      expect(hasTakaraApiKeyInEnv()).toBe(false);
      expect(() => resolveEmbeddingApiKey()).toThrow(/Takara credentials required/);
      normalizeTakaraApiKeyEnv();
      expect(process.env.TAKARA_API_KEY).toBeUndefined();
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
    const dir = await mkdtemp(join(tmpdir(), "miru-env-"));
    try {
      await writeFile(join(dir, ".env.local"), "TAKARA_API_KEY=file-token\n", "utf-8");
      process.env.TAKARA_API_KEY = "mcp-token";
      await loadEnvFiles({ cwd: dir, packageRoot: dir });
      expect(process.env.TAKARA_API_KEY).toBe("mcp-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.TAKARA_API_KEY;
    }
  });
});

describe("environment helpers", () => {
  test("uses the first non-empty string and integer values", () => {
    const saved = { A: process.env.A, B: process.env.B, N: process.env.N, BAD: process.env.BAD };
    try {
      process.env.A = "";
      process.env.B = "value";
      process.env.N = "2.8";
      process.env.BAD = "-1";
      expect(envFirstString(["A", "B"], "fallback")).toBe("value");
      expect(envFirstString(["A"], "fallback")).toBe("fallback");
      expect(envOptionalInt(["BAD", "N"])).toBe(2);
      expect(envOptionalInt(["BAD"], 1)).toBeUndefined();
      expect(envInt("N", 9)).toBe(2);
      expect(envInt("BAD", 9)).toBe(9);
      expect(envInt("MISSING_MIRU_TEST", 9)).toBe(9);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("normalizes API key whitespace and alternate placeholder", () => {
    const previous = process.env.TAKARA_API_KEY;
    try {
      process.env.TAKARA_API_KEY = "  real-token  ";
      expect(resolveEmbeddingApiKey()).toBe("real-token");
      expect(isUsableTakaraApiKey(" $TAKARA_API_KEY ")).toBe(false);
      normalizeTakaraApiKeyEnv();
      expect(hasTakaraApiKeyInEnv()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TAKARA_API_KEY;
      else process.env.TAKARA_API_KEY = previous;
    }
  });

  test("ranking switch recognizes true, false, and defaults on", () => {
    const previous = process.env.MIRU_SEARCH_V2;
    try {
      process.env.MIRU_SEARCH_V2 = "false";
      expect(searchImprovementsEnabled()).toBe(false);
      process.env.MIRU_SEARCH_V2 = "1";
      expect(searchImprovementsEnabled()).toBe(true);
      process.env.MIRU_SEARCH_V2 = "anything";
      expect(searchImprovementsEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MIRU_SEARCH_V2;
      else process.env.MIRU_SEARCH_V2 = previous;
    }
  });
});
