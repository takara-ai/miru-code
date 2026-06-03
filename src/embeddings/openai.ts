import { mapPool, resolveWorkerConcurrency } from "../concurrency.ts";
import { envFirstString, envOptionalInt, resolveEmbeddingApiKey } from "../env.ts";

const DEFAULT_MODEL = "ds1-potion-code-16m";
const DEFAULT_BASE_URL = "https://infer.dev.takara.ai/v1";
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_EMBED_CHARS = 1300;
const WINDOW_OVERLAP_CHARS = 120;

/** Native output size for Takara ds1-potion-code-16m (override with MIRU_EMBEDDING_DIMENSIONS). */
const MODEL_DEFAULT_DIMENSIONS: Record<string, number> = {
  "ds1-potion-code-16m": 256,
};

export interface EmbeddingTransportStats {
  requests: number;
  retries: number;
  payloadTooLarge: number;
  errors: number;
  inputItems: number;
  inputChars: number;
  totalRttMs: number;
  maxRttMs: number;
}

export interface EmbeddingBackend {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export function resolveEmbeddingModel(): string {
  return envFirstString(
    ["MIRU_OPENAI_EMBEDDING_MODEL", "SEMBLE_OPENAI_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"],
    DEFAULT_MODEL,
  );
}

export function resolveMaxEmbedChars(): number {
  return (
    envOptionalInt(["MIRU_MAX_EMBED_CHARS", "SEMBLE_MAX_EMBED_CHARS"], 256) ??
    DEFAULT_MAX_EMBED_CHARS
  );
}

function splitIntoWindows(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const out: string[] = [];
  const step = Math.max(64, maxChars - WINDOW_OVERLAP_CHARS);
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + maxChars);
    const part = text.slice(start, end);
    if (part.length > 0) {
      out.push(part);
    }
    if (end >= text.length) {
      break;
    }
  }
  return out;
}

function sanitizeEmbeddingInput(text: string): string {
  // Some OpenAI-compatible gateways mis-handle backslash escapes in JSON text
  // payloads. Keep a benchmark fallback mode to forcefully neutralize them.
  const mode = process.env.MIRU_EMBED_ESCAPE_MODE ?? process.env.SEMBLE_EMBED_ESCAPE_MODE ?? "quad";
  if (mode === "strip") {
    return text.replaceAll("\\", "/");
  }
  return text.replaceAll("\\", "\\\\\\\\");
}

function isPayloadTooLargeError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 413) {
    return true;
  }
  const message = (err as { message?: string }).message;
  if (typeof message === "string" && message.includes("413")) {
    return true;
  }
  return false;
}

export function resolveEmbeddingDimensions(model?: string): number | undefined {
  const fromEnv = envOptionalInt([
    "MIRU_EMBEDDING_DIMENSIONS",
    "SEMBLE_EMBEDDING_DIMENSIONS",
    "OPENAI_EMBEDDING_DIMENSIONS",
  ]);
  if (fromEnv != null) {
    return fromEnv;
  }
  return MODEL_DEFAULT_DIMENSIONS[model ?? resolveEmbeddingModel()];
}

export function resolveEmbeddingBatchSize(): number {
  return (
    envOptionalInt([
      "MIRU_EMBEDDING_BATCH_SIZE",
      "SEMBLE_EMBEDDING_BATCH_SIZE",
      "OPENAI_EMBEDDING_BATCH_SIZE",
    ]) ?? DEFAULT_BATCH_SIZE
  );
}

export function resolveEmbeddingBaseUrl(): string {
  return envFirstString(
    ["MIRU_OPENAI_BASE_URL", "SEMBLE_OPENAI_BASE_URL", "OPENAI_BASE_URL"],
    DEFAULT_BASE_URL,
  ).replace(/\/$/, "");
}

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

interface EmbeddingResponse {
  data: EmbeddingResponseItem[];
}

interface EmbeddingClient {
  createEmbeddings(
    input: string[] | string,
    model: string,
    dimensions?: number,
  ): Promise<EmbeddingResponse>;
}

class EmbeddingApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Embedding API error ${status}: ${body.slice(0, 500)}`);
    this.name = "EmbeddingApiError";
    this.status = status;
    this.body = body;
  }
}

function createClient(): EmbeddingClient {
  const apiKey = resolveEmbeddingApiKey();

  const baseUrl = resolveEmbeddingBaseUrl();
  const endpoint = `${baseUrl}/embeddings`;

  return {
    async createEmbeddings(
      input: string[] | string,
      model: string,
      dimensions?: number,
    ): Promise<EmbeddingResponse> {
      const body: Record<string, unknown> = { model, input };
      if (dimensions != null) {
        body.dimensions = dimensions;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new EmbeddingApiError(response.status, await response.text());
      }

      const payload = (await response.json()) as EmbeddingResponse;
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("Embedding API returned invalid payload");
      }
      return payload;
    },
  };
}

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly model: string;
  dimensions = 0;

  private readonly client: EmbeddingClient;
  private readonly batchSize: number;
  private readonly maxEmbedChars: number;
  private readonly requestedDimensions: number | undefined;
  private stats: EmbeddingTransportStats;

  constructor(options?: {
    model?: string;
    batchSize?: number;
    maxEmbedChars?: number;
    dimensions?: number;
    client?: EmbeddingClient;
  }) {
    this.model = options?.model ?? resolveEmbeddingModel();
    this.client = options?.client ?? createClient();
    this.batchSize = options?.batchSize ?? resolveEmbeddingBatchSize();
    this.maxEmbedChars = options?.maxEmbedChars ?? resolveMaxEmbedChars();
    this.requestedDimensions = options?.dimensions ?? resolveEmbeddingDimensions(this.model);
    this.stats = {
      requests: 0,
      retries: 0,
      payloadTooLarge: 0,
      errors: 0,
      inputItems: 0,
      inputChars: 0,
      totalRttMs: 0,
      maxRttMs: 0,
    };
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    interface WindowJob {
      docIndex: number;
      text: string;
    }

    const jobs: WindowJob[] = [];
    const windowVectors: Float32Array[][] = texts.map(() => []);

    for (let docIndex = 0; docIndex < texts.length; docIndex++) {
      const text = texts[docIndex];
      if (text === undefined) {
        continue;
      }
      const windows = splitIntoWindows(text, this.maxEmbedChars).map(sanitizeEmbeddingInput);
      for (const text of windows) {
        jobs.push({ docIndex, text });
      }
    }

    if (jobs.length === 0) {
      return texts.map(() => new Float32Array(0));
    }

    const batches: WindowJob[][] = [];
    for (let i = 0; i < jobs.length; i += this.batchSize) {
      batches.push(jobs.slice(i, i + this.batchSize));
    }

    const concurrency = resolveWorkerConcurrency();
    await mapPool(batches, concurrency, async (batch) => {
      const vectors = await this.embedBatchRawWithRetry(batch.map((job) => job.text));
      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        const vector = vectors[i];
        if (job === undefined || vector === undefined) {
          continue;
        }
        const bucket = windowVectors[job.docIndex];
        if (bucket) {
          bucket.push(vector);
        }
      }
    });

    const out = windowVectors.map((vectors) => poolWindowVectors(vectors));
    for (const vec of out) {
      if (this.dimensions === 0 && vec.length > 0) {
        this.dimensions = vec.length;
      }
    }
    return out;
  }

  private async embedBatchRawWithRetry(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    try {
      const started = performance.now();
      const response = await this.client.createEmbeddings(
        texts,
        this.model,
        this.requestedDimensions,
      );
      const elapsed = performance.now() - started;
      this.stats.requests += 1;
      this.stats.inputItems += texts.length;
      this.stats.inputChars += texts.reduce((acc, text) => acc + text.length, 0);
      this.stats.totalRttMs += elapsed;
      this.stats.maxRttMs = Math.max(this.stats.maxRttMs, elapsed);
      const vectors = vectorsFromResponse(response.data, texts.length);
      for (const vec of vectors) {
        if (this.requestedDimensions != null && vec.length !== this.requestedDimensions) {
          throw new Error(
            `Embedding API returned ${vec.length} dims for model ${this.model}, expected ${this.requestedDimensions}`,
          );
        }
        if (this.dimensions === 0) {
          this.dimensions = vec.length;
        } else if (vec.length !== this.dimensions) {
          throw new Error(
            `Inconsistent embedding dimensions in batch: ${vec.length} vs ${this.dimensions}`,
          );
        }
      }
      return vectors;
    } catch (err: unknown) {
      if (isPayloadTooLargeError(err) && texts.length > 1) {
        this.stats.payloadTooLarge += 1;
        this.stats.retries += 1;
        const mid = Math.ceil(texts.length / 2);
        const left = await this.embedBatchRawWithRetry(texts.slice(0, mid));
        const right = await this.embedBatchRawWithRetry(texts.slice(mid));
        return [...left, ...right];
      }
      if (isPayloadTooLargeError(err) && texts.length === 1) {
        this.stats.payloadTooLarge += 1;
        this.stats.retries += 1;
        const text = texts[0];
        if (!text) {
          this.stats.errors += 1;
          throw err;
        }
        if (text.length <= 128) {
          this.stats.errors += 1;
          throw err;
        }
        const mid = Math.floor(text.length / 2);
        const leftText = text.slice(0, mid);
        const rightText = text.slice(mid);
        const left = await this.embedBatchRawWithRetry([leftText]);
        const right = await this.embedBatchRawWithRetry([rightText]);
        return [...left, ...right];
      }
      this.stats.errors += 1;
      throw err;
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vec] = await this.embedDocuments([text]);
    if (!vec) {
      throw new Error("OpenAI returned no embedding for query");
    }
    return vec;
  }

  getStats(): EmbeddingTransportStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      requests: 0,
      retries: 0,
      payloadTooLarge: 0,
      errors: 0,
      inputItems: 0,
      inputChars: 0,
      totalRttMs: 0,
      maxRttMs: 0,
    };
  }
}

function vectorsFromResponse(data: EmbeddingResponseItem[], expected: number): Float32Array[] {
  const byIndex = new Map<number, Float32Array>();
  for (const item of data) {
    if (item.index >= 0 && item.index < expected) {
      byIndex.set(item.index, new Float32Array(item.embedding));
    }
  }
  if (byIndex.size !== expected) {
    throw new Error(
      `Embedding API returned ${data.length} vectors for ${expected} inputs (${byIndex.size} unique indices)`,
    );
  }
  return Array.from({ length: expected }, (_, i) => {
    const vec = byIndex.get(i);
    if (!vec) {
      throw new Error(`Missing embedding vector at index ${i}`);
    }
    return vec;
  });
}

function poolWindowVectors(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error("Embedding API returned no vectors");
  }
  const first = vectors[0];
  if (!first) {
    throw new Error("Embedding API returned no vectors");
  }
  if (vectors.length === 1) {
    return normalize(first);
  }
  const pooled = new Float32Array(first.length);
  for (const vec of vectors) {
    for (let i = 0; i < pooled.length; i++) {
      pooled[i] += vec[i] ?? 0;
    }
  }
  for (let i = 0; i < pooled.length; i++) {
    pooled[i] /= vectors.length;
  }
  return normalize(pooled);
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const value = vec[i] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return vec;
  }
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}

let defaultBackend: OpenAIEmbeddingBackend | null = null;

export function getEmbeddingBackend(model?: string): OpenAIEmbeddingBackend {
  if (model) {
    return new OpenAIEmbeddingBackend({
      model,
      dimensions: resolveEmbeddingDimensions(model),
    });
  }
  if (!defaultBackend) {
    defaultBackend = new OpenAIEmbeddingBackend();
  }
  return defaultBackend;
}
