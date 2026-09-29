import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSageMakerClient,
  preloadSageMakerSdk,
  type SageMakerEmbeddingConfig,
  validateSageMakerConnection,
} from "../src/embeddings/sagemaker.ts";

const config: SageMakerEmbeddingConfig = {
  endpointName: "miru-embeddings",
  region: "eu-west-2",
  normalize: true,
  truncate: true,
  truncationDirection: "Right",
};
let tempDir: string | undefined;
const envNames = ["HOME", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"] as const;
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  for (const name of envNames) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function testModules(
  send: (command: { input: Record<string, unknown> }) => Promise<unknown>,
  credentialsFail = false,
) {
  let clients = 0;
  let commands = 0;
  class FakeCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      commands++;
    }
  }
  class FakeClient {
    private readonly options: { credentials: () => Promise<unknown> };
    constructor(options: { credentials: () => Promise<unknown> }) {
      this.options = options;
      clients++;
    }
    async send(command: FakeCommand): Promise<unknown> {
      await this.options.credentials();
      return send(command);
    }
  }
  const loaders = {
    loadRuntime: async () =>
      ({ SageMakerRuntimeClient: FakeClient, InvokeEndpointCommand: FakeCommand }) as never,
    loadCredentials: async () =>
      ({
        defaultProvider: () => async () => {
          if (credentialsFail) throw new Error("no provider credentials");
          return { accessKeyId: "key", secretAccessKey: "secret" };
        },
      }) as never,
  };
  return {
    loaders,
    get counts() {
      return { clients, commands };
    },
  };
}

function response(body: unknown): { Body: Uint8Array } {
  return { Body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe("SageMaker invoke adapter", () => {
  test("preloads and reuses the lazily loaded AWS SDK modules", async () => {
    await preloadSageMakerSdk();
    await preloadSageMakerSdk();
  });

  test("builds endpoint requests, caches the SDK client, and maps embedding response forms", async () => {
    const modules = testModules(async (command) => {
      const body = JSON.parse(new TextDecoder().decode(command.input.Body as Uint8Array));
      expect(command.input).toMatchObject({
        EndpointName: "miru-embeddings",
        ContentType: "application/json",
        Accept: "application/json",
      });
      expect(body).toMatchObject({
        inputs: ["first"],
        normalize: true,
        truncate: true,
        truncation_direction: "Right",
        dimensions: 3,
      });
      return response({ embeddings: [[0.1, 0.2, 0.3]] });
    });
    const client = createSageMakerClient({ ...config, promptName: "query" }, modules.loaders);
    expect(await client.createEmbeddings(["first"], "ignored", 3)).toEqual({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    });
    expect(await client.createEmbeddings(["first"], "ignored", 3)).toEqual({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    });
    expect(modules.counts).toEqual({ clients: 1, commands: 2 });

    const dataClient = createSageMakerClient(
      config,
      testModules(async () =>
        response({
          data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
        }),
      ).loaders,
    );
    expect(await dataClient.createEmbeddings("query", "model")).toEqual({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
    });
    const arrayClient = createSageMakerClient(
      config,
      testModules(async () => response([[1, 2]])).loaders,
    );
    expect(await arrayClient.createEmbeddings("query", "model")).toEqual({
      data: [{ index: 0, embedding: [1, 2] }],
    });
  });

  test("reports empty, invalid JSON, and unsupported endpoint response bodies", async () => {
    const noBody = createSageMakerClient(
      config,
      testModules(async () => ({ Body: undefined })).loaders,
    );
    await expect(noBody.createEmbeddings("q", "m")).rejects.toThrow("empty response body");

    const invalidJson = createSageMakerClient(
      config,
      testModules(async () => ({
        Body: new TextEncoder().encode("{"),
      })).loaders,
    );
    await expect(invalidJson.createEmbeddings("q", "m")).rejects.toThrow("invalid JSON");

    const invalidShape = createSageMakerClient(
      config,
      testModules(async () => response({ values: [] })).loaders,
    );
    await expect(invalidShape.createEmbeddings("q", "m")).rejects.toThrow(
      "unrecognized embedding payload shape",
    );
  });

  test("uses case-insensitive static AWS profile files when the SDK chain fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "miru-sagemaker-profile-"));
    const configPath = join(tempDir, "config");
    const credentialsPath = join(tempDir, "credentials");
    await writeFile(configPath, "[profile miru]\nregion = eu-west-2\n");
    await writeFile(
      credentialsPath,
      "[miru]\nAWS_ACCESS_KEY_ID = AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY = secret\nAWS_SESSION_TOKEN = session\n",
    );
    process.env.AWS_PROFILE = "miru";
    process.env.HOME = tempDir;
    process.env.AWS_CONFIG_FILE = "~/config";
    process.env.AWS_SHARED_CREDENTIALS_FILE = "~/credentials";
    const modules = testModules(async () => response({ embeddings: [[0.3]] }), true);
    const client = createSageMakerClient({ ...config, profile: "miru" }, modules.loaders);
    expect(await client.createEmbeddings("q", "m")).toEqual({
      data: [{ index: 0, embedding: [0.3] }],
    });
  });

  test("validates empty and successful embedding responses and reports failures", async () => {
    const empty = await validateSageMakerConnection(config, () => ({
      createEmbeddings: async () => ({ data: [] }),
    }));
    expect(empty).toEqual({
      valid: false,
      message: "SageMaker endpoint returned an empty response.",
    });

    const valid = await validateSageMakerConnection(config, () => ({
      createEmbeddings: async () => ({ data: [{ index: 0, embedding: [0.1] }] }),
    }));
    expect(valid).toEqual({ valid: true, message: "SageMaker endpoint responded successfully." });

    const failed = await validateSageMakerConnection(config, () => ({
      createEmbeddings: async () => {
        throw Object.assign(new Error("denied"), { status: 403 });
      },
    }));
    expect(failed).toEqual({ valid: false, status: 403, message: "denied" });

    const nonError = await validateSageMakerConnection(config, () => ({
      createEmbeddings: async () => {
        throw "unavailable";
      },
    }));
    expect(nonError).toEqual({ valid: false, message: "unavailable" });
  });
});
