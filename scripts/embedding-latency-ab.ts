/**
 * A/B latency check: Takara cloud vs self-hosted SageMaker, same query text, same process.
 * Requires both TAKARA_API_KEY and MIRU_SAGEMAKER_ENDPOINT_ARN to be resolvable (env, .env.local,
 * or `miru setup` credentials.json) — whichever is missing gets skipped rather than failing.
 *
 * Usage:
 *   bun run scripts/embedding-latency-ab.ts
 *   bun run scripts/embedding-latency-ab.ts --text "how does auth middleware work" --iterations 8
 */
import { loadStoredCredentials } from "../src/credentials.ts";
import { OpenAIEmbeddingBackend, resolveTakaraEmbeddingModel } from "../src/embeddings/openai.ts";
import { createSageMakerClient, resolveSageMakerConfig } from "../src/embeddings/sagemaker.ts";
import { hasTakaraApiKeyInEnv, normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";

await loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const args = process.argv.slice(2);
let text = "how does the authentication middleware work";
let iterations = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--text" && args[i + 1]) {
    text = args[++i] as string;
  } else if (args[i] === "--iterations" && args[i + 1]) {
    iterations = Number(args[++i]) || iterations;
  }
}

interface Timing {
  label: string;
  dims: number;
  samples: number[];
  error?: string;
}

async function timeBackend(label: string, backend: OpenAIEmbeddingBackend): Promise<Timing> {
  try {
    await backend.embedQuery(text); // warm-up: excludes one-time TCP/TLS setup from steady state
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      await backend.embedQuery(text);
      samples.push(performance.now() - started);
    }
    return { label, dims: backend.dimensions, samples };
  } catch (err) {
    return { label, dims: 0, samples: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function stats(samples: number[]): { min: number; median: number; mean: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return {
    min: sorted[0] ?? 0,
    median,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const results: Timing[] = [];

if (hasTakaraApiKeyInEnv()) {
  results.push(
    await timeBackend(
      "Takara",
      new OpenAIEmbeddingBackend({ model: resolveTakaraEmbeddingModel() }),
    ),
  );
} else {
  console.log("Skipping Takara — no TAKARA_API_KEY found.");
}

const sageMakerConfig = resolveSageMakerConfig();
if (sageMakerConfig) {
  results.push(
    await timeBackend(
      `SageMaker (${sageMakerConfig.endpointName})`,
      new OpenAIEmbeddingBackend({ client: createSageMakerClient(sageMakerConfig) }),
    ),
  );
} else {
  console.log("Skipping SageMaker — no MIRU_SAGEMAKER_ENDPOINT_ARN found.");
}

console.log("");
console.log(`Query: "${text}"  (${iterations} timed calls each, after 1 warm-up call)`);
console.log("");

for (const result of results) {
  if (result.error) {
    console.log(`${result.label}: FAILED — ${result.error}`);
    continue;
  }
  const s = stats(result.samples);
  console.log(
    `${result.label.padEnd(28)} dims=${String(result.dims).padEnd(5)} ` +
      `min=${s.min.toFixed(0)}ms  median=${s.median.toFixed(0)}ms  ` +
      `mean=${s.mean.toFixed(0)}ms  max=${s.max.toFixed(0)}ms`,
  );
}

const [a, b] = results;
if (a && b && !a.error && !b.error) {
  const aMedian = stats(a.samples).median;
  const bMedian = stats(b.samples).median;
  const [faster, slower, fasterMedian, slowerMedian] =
    aMedian <= bMedian ? [a, b, aMedian, bMedian] : [b, a, bMedian, aMedian];
  console.log("");
  console.log(
    `${faster.label} is ~${(slowerMedian - fasterMedian).toFixed(0)}ms faster per query ` +
      `(${(slowerMedian / fasterMedian).toFixed(2)}x) than ${slower.label} on this network, ` +
      "for this query.",
  );
}
