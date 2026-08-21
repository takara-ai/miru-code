import { Aws, CfnOutput, CfnParameter, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnEndpoint, CfnEndpointConfig, CfnModel } from "aws-cdk-lib/aws-sagemaker";
import type { Construct } from "constructs";

/**
 * Deploys a SageMaker real-time endpoint from the DS1 AWS Marketplace model package,
 * for use with Miru. Mirrors ../cloudformation/sagemaker-marketplace-endpoint.yml —
 * same parameters, resources, and outputs, built with CDK's L1 (Cfn*) constructs
 * rather than opinionated L2 constructs, so the two stay in lockstep.
 */
export class SageMakerMarketplaceEndpointStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const modelPackageArn = new CfnParameter(this, "ModelPackageArn", {
      type: "String",
      description:
        "ARN of the subscribed DS1 AWS Marketplace model package for this region " +
        "(copy from the AWS Marketplace listing page after subscribing)",
    });

    const endpointName = new CfnParameter(this, "EndpointName", {
      type: "String",
      default: "ds1-endpoint",
      description: "Name for the SageMaker endpoint",
    });

    const instanceType = new CfnParameter(this, "InstanceType", {
      type: "String",
      default: "ml.c5.xlarge",
      description: "SageMaker instance type for the endpoint",
    });

    const initialInstanceCount = new CfnParameter(this, "InitialInstanceCount", {
      type: "Number",
      default: 1,
      minValue: 1,
      description: "Number of instances for the production variant",
    });

    const region = new CfnParameter(this, "Region", {
      type: "String",
      description:
        "AWS region you are deploying into. Must match the --region/env you deploy " +
        "with and the region of your ModelPackageArn — this parameter does not change " +
        "where the stack deploys, it documents and lets you cross-check the intended region.",
    });

    const executionRole = new CfnRole(this, "SageMakerExecutionRole", {
      roleName: `sagemaker-marketplace-exec-${endpointName.valueAsString}`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "sagemaker.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      policies: [
        {
          policyName: "sagemaker-marketplace-logs",
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "Logs",
                Effect: "Allow",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                  "logs:DescribeLogStreams",
                ],
                Resource: `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/sagemaker/Endpoints/${endpointName.valueAsString}*`,
              },
            ],
          },
        },
      ],
    });

    const model = new CfnModel(this, "Model", {
      modelName: `${endpointName.valueAsString}-model`,
      executionRoleArn: executionRole.attrArn,
      enableNetworkIsolation: true,
      primaryContainer: {
        modelPackageName: modelPackageArn.valueAsString,
      },
    });
    model.addResourceDependency(executionRole);

    const endpointConfig = new CfnEndpointConfig(this, "EndpointConfig", {
      endpointConfigName: `${endpointName.valueAsString}-config`,
      productionVariants: [
        {
          variantName: "AllTraffic",
          modelName: model.attrModelName,
          initialInstanceCount: initialInstanceCount.valueAsNumber,
          instanceType: instanceType.valueAsString,
          containerStartupHealthCheckTimeoutInSeconds: 900,
        },
      ],
    });
    endpointConfig.addResourceDependency(model);

    const endpoint = new CfnEndpoint(this, "Endpoint", {
      endpointName: endpointName.valueAsString,
      endpointConfigName: endpointConfig.attrEndpointConfigName,
      tags: [{ key: "ExpectedRegion", value: region.valueAsString }],
    });
    endpoint.addResourceDependency(endpointConfig);

    new CfnOutput(this, "ExecutionRoleArn", {
      description: "IAM role ARN used by the SageMaker endpoint (needed for Miru configuration)",
      value: executionRole.attrArn,
    });
    new CfnOutput(this, "EndpointArn", {
      description: "SageMaker endpoint ARN (needed for Miru configuration)",
      value: endpoint.attrEndpointArn,
    });
    new CfnOutput(this, "EndpointNameOut", {
      description: "Endpoint name",
      value: endpointName.valueAsString,
    });
    new CfnOutput(this, "RegionOut", {
      description: "AWS region the stack was deployed into",
      value: Aws.REGION,
    });
  }
}
