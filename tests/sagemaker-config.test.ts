import { afterEach, describe, expect, test } from "bun:test";
import {
  isSageMakerConfigured,
  parseSageMakerEndpointArn,
  resolveSageMakerConfig,
} from "../src/embeddings/sagemaker.ts";

const names = [
  "MIRU_SAGEMAKER_ENDPOINT_ARN",
  "MIRU_SAGEMAKER_ENDPOINT_NAME",
  "MIRU_SAGEMAKER_REGION",
  "MIRU_SAGEMAKER_NORMALIZE",
  "MIRU_SAGEMAKER_TRUNCATE",
  "MIRU_SAGEMAKER_TRUNCATION_DIRECTION",
  "MIRU_SAGEMAKER_PROMPT_NAME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
] as const;
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("SageMaker configuration", () => {
  test("parses AWS partition ARNs and rejects malformed endpoints", () => {
    expect(
      parseSageMakerEndpointArn(" arn:aws-cn:sagemaker:cn-north-1:123456789012:endpoint/embed "),
    ).toEqual({ region: "cn-north-1", accountId: "123456789012", endpointName: "embed" });
    expect(() => parseSageMakerEndpointArn("not-an-arn")).toThrow("Invalid SageMaker endpoint ARN");
  });

  test("resolves ARN config and options", () => {
    process.env.MIRU_SAGEMAKER_ENDPOINT_ARN =
      "arn:aws:sagemaker:eu-west-2:123456789012:endpoint/text";
    process.env.MIRU_SAGEMAKER_NORMALIZE = "FALSE";
    process.env.MIRU_SAGEMAKER_TRUNCATE = "0";
    process.env.MIRU_SAGEMAKER_TRUNCATION_DIRECTION = "Left";
    process.env.MIRU_SAGEMAKER_PROMPT_NAME = " task ";
    process.env.AWS_PROFILE = " profile ";
    expect(resolveSageMakerConfig()).toEqual({
      endpointName: "text",
      region: "eu-west-2",
      profile: "profile",
      normalize: false,
      truncate: false,
      truncationDirection: "Left",
      promptName: "task",
    });
    expect(isSageMakerConfigured()).toBe(true);
  });

  test("uses explicit endpoint name and region fallback order", () => {
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    process.env.MIRU_SAGEMAKER_ENDPOINT_NAME = " endpoint ";
    process.env.AWS_REGION = " eu-central-1 ";
    process.env.MIRU_SAGEMAKER_REGION = " ";
    process.env.MIRU_SAGEMAKER_TRUNCATION_DIRECTION = "left";
    expect(resolveSageMakerConfig()).toMatchObject({
      endpointName: "endpoint",
      region: "eu-central-1",
      normalize: true,
      truncate: true,
      truncationDirection: "Right",
    });
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = "us-east-1";
    expect(resolveSageMakerConfig()?.region).toBe("us-east-1");
  });

  test("returns null when unconfigured and explains a missing region", () => {
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_ARN;
    delete process.env.MIRU_SAGEMAKER_ENDPOINT_NAME;
    expect(resolveSageMakerConfig()).toBeNull();
    process.env.MIRU_SAGEMAKER_ENDPOINT_NAME = "endpoint";
    delete process.env.MIRU_SAGEMAKER_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => resolveSageMakerConfig()).toThrow("no AWS region was found");
    expect(() => isSageMakerConfigured()).toThrow("no AWS region was found");
  });
});
