import * as z from "zod";
import { loadStoredCredentials } from "../../src/credentials.ts";
import {
  type EmbeddingBackend,
  OpenAIEmbeddingBackend,
  resolveTakaraEmbeddingModel,
  sageMakerModelId,
} from "../../src/embeddings/openai.ts";
import { createSageMakerClient, resolveSageMakerConfig } from "../../src/embeddings/sagemaker.ts";
import { hasTakaraApiKeyInEnv } from "../../src/env.ts";
import { loadEnvFiles } from "../../src/env-files.ts";

const fixtureSchema = z.strictObject({
  documents: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(5),
  cases: z
    .array(z.object({ query: z.string().min(1), relevant: z.array(z.string().min(1)).min(1) }))
    .min(1),
});

const [fixtureFile] = process.argv.slice(2);
if (!fixtureFile) throw new Error("Pass a labelled JSON corpus.");
const { documents, cases } = fixtureSchema.parse(await Bun.file(fixtureFile).json());
const ids = new Set(documents.map((doc) => doc.id));
if (
  ids.size !== documents.length ||
  cases.some(({ relevant }) => relevant.some((id) => !ids.has(id)))
) {
  throw new Error(
    "Document IDs must be unique and every relevance label must reference a document.",
  );
}

await loadEnvFiles();
await loadStoredCredentials();
const sag = resolveSageMakerConfig();
if (!sag || !hasTakaraApiKeyInEnv()) {
  throw new Error("Configure both the SageMaker endpoint and an authorised Takara API key.");
}

function cosine(query: Float32Array, doc: Float32Array) {
  if (query.length !== 256 || doc.length !== 256)
    throw new Error("Expected 256-dimensional ds1-code vectors.");
  let dot = 0;
  let a = 0;
  let b = 0;
  for (const [i, value] of query.entries()) {
    const other = doc[i] ?? 0;
    dot += value * other;
    a += value * value;
    b += other * other;
  }
  const similarity = dot / Math.sqrt(a * b);
  if (!Number.isFinite(similarity))
    throw new Error("Endpoint returned a zero or invalid embedding.");
  return similarity;
}

async function benchmark(backend: EmbeddingBackend) {
  const startIndex = performance.now();
  const embeddings = await backend.embedDocuments(documents.map(({ text }) => text));
  const indexMs = performance.now() - startIndex;
  const warmup = cases[0];
  if (!warmup) throw new Error("Benchmark needs one query.");
  await backend.embedQuery(warmup.query);
  const times: number[] = [];
  const hits: number[] = [];
  const reciprocals: number[] = [];
  const rankings: string[][] = [];
  for (const { query, relevant } of cases) {
    const startQuery = performance.now();
    const vector = await backend.embedQuery(query);
    times.push(performance.now() - startQuery);
    const ranked = embeddings
      .map((doc, i) => ({ id: documents[i]?.id ?? "", score: cosine(vector, doc) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map(({ id }) => id);
    const expected = new Set(relevant);
    const first = ranked.findIndex((id) => expected.has(id));
    hits.push(ranked.filter((id) => expected.has(id)).length / expected.size);
    reciprocals.push(first === -1 ? 0 : 1 / (first + 1));
    rankings.push(ranked);
  }
  times.sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  return {
    model: backend.model,
    indexMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    recallAt5: mean(hits),
    mrrAt5: mean(reciprocals),
    rankings,
  };
}

const takara = await benchmark(
  new OpenAIEmbeddingBackend({ model: resolveTakaraEmbeddingModel() }),
);
const sagemaker = await benchmark(
  new OpenAIEmbeddingBackend({
    model: sageMakerModelId(sag.endpointName),
    client: createSageMakerClient(sag),
  }),
);
console.log(
  JSON.stringify(
    { documents: documents.length, queries: cases.length, takara, sagemaker },
    null,
    2,
  ),
);
