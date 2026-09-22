import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingBackend } from "../src/embeddings/openai.ts";
import { createIndexFromPath } from "../src/index/create.ts";
import { defaultContentTypes } from "../src/types.ts";
import { unitVector } from "./test-helpers.ts";

function mockEmbeddings(): EmbeddingBackend {
  return {
    model: "mock-default-scope",
    dimensions: 8,
    async embedDocuments(texts: string[]) {
      return texts.map((_, i) => unitVector(8, i % 8));
    },
    async embedQuery(text: string) {
      return unitVector(8, text.length % 8);
    },
  };
}

test("default content scope indexes docs alongside code and config", async () => {
  const root = await mkdtemp(join(tmpdir(), "miru-default-scope-"));
  try {
    await writeFile(
      join(root, "README.md"),
      "# widget-service\n\nExplains the miruReadmeOnboardingSecret setup flow.\n",
      "utf-8",
    );
    await writeFile(join(root, "app.ts"), "export const port = 8080;\n", "utf-8");

    const embeddings = mockEmbeddings();
    const built = await createIndexFromPath(root, embeddings, defaultContentTypes(), root);

    const indexedPaths = built.chunks.map((c) => c.file_path);
    expect(indexedPaths).toContain("README.md");
    expect(indexedPaths).toContain("app.ts");
    expect(built.chunks.some((c) => c.content.includes("miruReadmeOnboardingSecret"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
