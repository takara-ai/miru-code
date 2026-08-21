#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { SageMakerMarketplaceEndpointStack } from "../lib/sagemaker-marketplace-endpoint-stack";

const app = new App();

// Required explicitly: without `env`, CDK deploys to whatever region the current AWS
// profile/config defaults to (often not the region your ModelPackageArn is scoped to),
// silently ignoring CDK_DEFAULT_REGION unless it's wired through here.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
if (!account || !region) {
  throw new Error(
    "CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set (cdk deploy sets these " +
      "automatically from your AWS credentials/profile, but double check --region/--profile " +
      "match the region your ModelPackageArn was issued for).",
  );
}

new SageMakerMarketplaceEndpointStack(app, "SageMakerMarketplaceEndpointStack", {
  description: "SageMaker real-time endpoint for the DS1 AWS Marketplace model package",
  env: { account, region },
});
