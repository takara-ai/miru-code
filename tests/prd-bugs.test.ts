/**
 * Regression tests for DS1-Miru Linear issues (PRD-218–PRD-229).
 *
 * Open bugs: tests assert desired fixed behavior and are expected to FAIL until resolved.
 * Fixed bugs (PRD-220, PRD-227): passing regression guards.
 *
 * Run in isolation: `bun test tests/prd-bugs.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import {
  OpenAIEmbeddingBackend,
  resolveEmbeddingBaseUrl,
  sanitizeEmbeddingInput,
} from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { IndexCache, mcpWatchEnabled } from "../src/mcp/index-cache.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import {
  clampMcpTopK,
  isAllowedRepoSource,
  MAX_MCP_TOP_K,
  validateLocalRepoPath,
} from "../src/utils.ts";

function oneHot(dim: number, index: number): number[] {
  const vec = Array.from({ length: dim }, () => 0);
  vec[index] = 1;
  return vec;
}

function payloadTooLargeError(): Error {
  const err = new Error("Embedding API error 413");
  (err as { status?: number }).status = 413;
  return err;
}

function transientError(status: number): Error {
  const err = new Error(`Embedding API error ${status}`);
  (err as { status?: number }).status = status;
  return err;
}

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-prd",
    dimensions: 3,
    async embedDocuments(texts: string[]) {
      return texts.map(() => new Float32Array([1, 0, 0]));
    },
    async embedQuery() {
      return new Float32Array([1, 0, 0]);
    },
  };
}

type OpenAIEmbeddingBackendInternals = {
  embedBatchRawWithRetry(texts: string[]): Promise<Float32Array[]>;
};

async function captureIndexProfile(
  root: string,
  embeddings: EmbeddingBackend,
): Promise<Record<string, unknown>> {
  const prev = process.env.MIRU_PROFILE;
  process.env.MIRU_PROFILE = "1";
  const lines: string[] = [];
  const origError = console.error;
  console.error = (msg: unknown) => {
    lines.push(String(msg));
  };
  try {
    await createIndexFromPath(root, embeddings, ["code"], root);
  } finally {
    console.error = origError;
    if (prev === undefined) {
      delete process.env.MIRU_PROFILE;
    } else {
      process.env.MIRU_PROFILE = prev;
    }
  }
  const line = lines.find((entry) => entry.includes('"profile":"index_build"'));
  if (!line) {
    throw new Error("Expected index_build profile line on stderr");
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe("PRD-218: single-input 413 must not misalign embedding vectors", () => {
  test("embedBatchRawWithRetry returns exactly one vector per input on HTTP 413", async () => {
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 10_000,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          if (texts.length === 1 && texts[0]!.length > 128) {
            throw payloadTooLargeError();
          }
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: oneHot(3, index),
            })),
          };
        },
      },
    });

    const internals = backend as unknown as OpenAIEmbeddingBackendInternals;
    const vectors = await internals.embedBatchRawWithRetry(["x".repeat(300)]);

    expect(vectors).toHaveLength(1);
  });

  test("embedDocuments keeps positional alignment when a document window hits HTTP 413", async () => {
    const embeddingForText = (text: string): number[] => {
      if (text === "doc-a") {
        return oneHot(3, 0);
      }
      if (text === "doc-c") {
        return oneHot(3, 2);
      }
      return oneHot(3, 1);
    };
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 10_000,
      client: {
        async createEmbeddings(input) {
          const texts = Array.isArray(input) ? input : [input];
          if (texts.some((text) => text.length > 128)) {
            throw payloadTooLargeError();
          }
          return {
            data: texts.map((text, index) => ({
              index,
              embedding: embeddingForText(text),
            })),
          };
        },
      },
    });

    const vectors = await backend.embedDocuments(["doc-a", "x".repeat(300), "doc-c"]);

    expect(vectors).toHaveLength(3);
    expect(vectors[0]?.[0]).toBeCloseTo(1, 5);
    expect(vectors[1]?.[1]).toBeCloseTo(1, 5);
    expect(vectors[2]?.[2]).toBeCloseTo(1, 5);
  });
});

describe("PRD-219: sanitizeEmbeddingInput must preserve backslashes", () => {
  test("default mode leaves backslashes unchanged", () => {
    const prevMiru = process.env.MIRU_EMBED_ESCAPE_MODE;
    delete process.env.MIRU_EMBED_ESCAPE_MODE;
    try {
      expect(sanitizeEmbeddingInput(String.raw`path\to\file`)).toBe(String.raw`path\to\file`);
      expect(sanitizeEmbeddingInput(String.raw`regex \d+ \\w+`)).toBe(String.raw`regex \d+ \\w+`);
    } finally {
      if (prevMiru === undefined) {
        delete process.env.MIRU_EMBED_ESCAPE_MODE;
      } else {
        process.env.MIRU_EMBED_ESCAPE_MODE = prevMiru;
      }
    }
  });
});

describe("PRD-221: transient embedding API errors should retry with backoff", () => {
  test("retries HTTP 429 before succeeding", async () => {
    let attempts = 0;
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          attempts++;
          if (attempts === 1) {
            throw transientError(429);
          }
          const texts = Array.isArray(input) ? input : [input];
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: oneHot(3, index),
            })),
          };
        },
      },
    });

    const [vector] = await backend.embedDocuments(["hello"]);
    expect(attempts).toBeGreaterThan(1);
    expect(vector?.[0]).toBeCloseTo(1, 5);
  });

  test("retries HTTP 503 before succeeding", async () => {
    let attempts = 0;
    const backend = new OpenAIEmbeddingBackend({
      model: "test-embed-model",
      dimensions: 3,
      batchSize: 32,
      maxEmbedChars: 1300,
      client: {
        async createEmbeddings(input) {
          attempts++;
          if (attempts < 3) {
            throw transientError(503);
          }
          const texts = Array.isArray(input) ? input : [input];
          return {
            data: texts.map((_, index) => ({
              index,
              embedding: oneHot(3, index),
            })),
          };
        },
      },
    });

    await backend.embedDocuments(["retry-me"]);
    expect(attempts).toBe(3);
  });
});

describe("PRD-222: indexing guardrails", () => {
  test("PRD-226: rejects plain http:// git URLs by default", () => {
    expect(isAllowedRepoSource("http://github.com/org/repo")).toBe(false);
  });

  test("validateLocalRepoPath enforces MIRU_WORKSPACE_ROOT for local paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miru-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "miru-outside-"));
    const prevRoot = process.env.MIRU_WORKSPACE_ROOT;
    process.env.MIRU_WORKSPACE_ROOT = workspace;
    try {
      expect(() => validateLocalRepoPath(outside)).toThrow(/outside workspace/i);
      expect(() => validateLocalRepoPath(join(workspace, "src"))).not.toThrow();
    } finally {
      if (prevRoot === undefined) {
        delete process.env.MIRU_WORKSPACE_ROOT;
      } else {
        process.env.MIRU_WORKSPACE_ROOT = prevRoot;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("honours MIRU_MAX_INDEX_FILES aggregate budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-budget-"));
    const prev = process.env.MIRU_MAX_INDEX_FILES;
    process.env.MIRU_MAX_INDEX_FILES = "1";
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
      await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
      await expect(createIndexFromPath(root, mockEmbeddings(), ["code"], root)).rejects.toThrow(
        /file budget|max.*files/i,
      );
    } finally {
      if (prev === undefined) {
        delete process.env.MIRU_MAX_INDEX_FILES;
      } else {
        process.env.MIRU_MAX_INDEX_FILES = prev;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PRD-223: MCP server version must match package.json", () => {
  test("createMcpServer reports package version in handshake", () => {
    const server = createMcpServer(new IndexCache());
    const info = (server as { server: { _serverInfo: { version: string } } }).server._serverInfo;
    expect(info.version).toBe(packageJson.version);
  });
});

describe("PRD-224: IndexCache watcher must be per cached repo", () => {
  test("startWatcher keeps independent handles for multiple local repos", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "miru-watch-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "miru-watch-b-"));
    try {
      const cache = new IndexCache(["code"]);
      const internals = cache as unknown as {
        watcher: { close(): void } | null;
        watchers?: Map<string, { close(): void }>;
        startWatcher(path: string): void;
      };

      internals.startWatcher(resolve(rootA));
      const watcherAfterA = internals.watcher;
      expect(watcherAfterA).not.toBeNull();

      internals.startWatcher(resolve(rootB));
      const watcherAfterB = internals.watcher;

      expect(internals.watchers?.size ?? 0).toBe(2);
      expect(watcherAfterA).not.toBe(watcherAfterB);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });
});

describe("PRD-228: file read failures must not be silently counted as empty files", () => {
  test("index profile reports file_errors separately from empty_or_skipped_files", async () => {
    const root = await mkdtemp(join(tmpdir(), "miru-file-errors-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/good.ts"), "export const ok = 1;\n");
      const badPath = join(root, "src/bad.ts");
      await writeFile(badPath, "export const bad = 2;\n");
      await chmod(badPath, 0o000);

      const profile = await captureIndexProfile(root, mockEmbeddings());

      expect(profile.file_errors).toBe(1);
      expect(profile.empty_or_skipped_files).toBe(0);
    } finally {
      try {
        await chmod(join(root, "src/bad.ts"), 0o644);
      } catch {
        // ignore cleanup chmod failure
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("PRD-220 / PRD-227 / PRD-229: fixed regressions", () => {
  test("PRD-220: default embedding base URL is production infer", () => {
    const prevMiru = process.env.MIRU_OPENAI_BASE_URL;
    const prevOpenAi = process.env.OPENAI_BASE_URL;
    delete process.env.MIRU_OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      expect(resolveEmbeddingBaseUrl()).toBe("https://infer.takara.ai/v1");
    } finally {
      if (prevMiru === undefined) delete process.env.MIRU_OPENAI_BASE_URL;
      else process.env.MIRU_OPENAI_BASE_URL = prevMiru;
      if (prevOpenAi === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevOpenAi;
    }
  });

  test("PRD-227: MCP top_k is capped", () => {
    expect(clampMcpTopK(999)).toBe(MAX_MCP_TOP_K);
    expect(MAX_MCP_TOP_K).toBeLessThanOrEqual(50);
  });

  test("PRD-229: source tree has no SEMBLE_* env var aliases", () => {
    const srcRoot = new URL("../src", import.meta.url).pathname;
    const hits = collectSourceFiles(srcRoot).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/SEMBLE_[A-Z0-9_]+/g) ?? [];
      return matches.map((match) => `${file}: ${match}`);
    });
    expect(hits).toEqual([]);
  });

  test("PRD-229: mcpWatchEnabled ignores legacy SEMBLE_MCP_WATCH", () => {
    const prevMiru = process.env.MIRU_MCP_WATCH;
    delete process.env.MIRU_MCP_WATCH;
    process.env.SEMBLE_MCP_WATCH = "0";
    try {
      expect(mcpWatchEnabled()).toBe(true);
    } finally {
      if (prevMiru === undefined) {
        delete process.env.MIRU_MCP_WATCH;
      } else {
        process.env.MIRU_MCP_WATCH = prevMiru;
      }
      delete process.env.SEMBLE_MCP_WATCH;
    }
  });
});
