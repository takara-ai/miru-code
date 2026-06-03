import {
  resolveEmbeddingBaseUrl,
  resolveEmbeddingDimensions,
  resolveEmbeddingModel,
} from "./openai.ts";

export interface ValidateApiKeyResult {
  valid: boolean;
  status?: number;
  message: string;
}

export async function validateEmbeddingApiKey(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}): Promise<ValidateApiKeyResult> {
  const baseUrl = (options.baseUrl ?? resolveEmbeddingBaseUrl()).replace(/\/$/, "");
  const model = options.model ?? resolveEmbeddingModel();
  const dimensions = options.dimensions ?? resolveEmbeddingDimensions(model);
  const endpoint = `${baseUrl}/embeddings`;

  const body: Record<string, unknown> = {
    model,
    input: "miru setup validation",
  };
  if (dimensions != null) {
    body.dimensions = dimensions;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      message: `Could not reach embedding API at ${baseUrl}: ${message}`,
    };
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        status: response.status,
        message: "Invalid API key (authentication failed).",
      };
    }
    return {
      valid: false,
      status: response.status,
      message: `Embedding API returned ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  try {
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      return {
        valid: false,
        status: response.status,
        message: "Embedding API returned an empty response.",
      };
    }
    if (dimensions != null && embedding.length !== dimensions) {
      return {
        valid: false,
        status: response.status,
        message: `Expected ${dimensions} embedding dimensions, got ${embedding.length}.`,
      };
    }
  } catch {
    return {
      valid: false,
      status: response.status,
      message: "Embedding API returned invalid JSON.",
    };
  }

  return { valid: true, status: response.status, message: "API key is valid." };
}
