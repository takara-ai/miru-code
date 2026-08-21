# Self-hosted embeddings (AWS SageMaker)

Run Miru against your own SageMaker embedding endpoint instead of Takara's hosted API (`infer.takara.ai`).

The embedding model is sold on AWS Marketplace:

**[Takara DS1 Miru (int8) — AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)**

## Overview

| Step | Who       | What                                                                          |
| ---- | --------- | ------------------------------------------------------------------------------ |
| 1    | AWS admin | Subscribe on Marketplace                                                       |
| 2    | AWS admin | Deploy the endpoint with the CloudFormation/CDK template (below)               |
| 3    | AWS admin | Create an invoke-only IAM user / profile (runbook below)                       |
| 4    | Developer | `miru setup --sagemaker` — Miru validates and saves the endpoint               |

Miru **never** creates IAM users, IAM roles, SageMaker resources, or writes `~/.aws`. It only inherits a profile you already have and checks that it can call the endpoint.

## One mode at a time

Miru stores **either** a Takara API key **or** a SageMaker endpoint — never both.

- `miru setup --sagemaker …` **removes** any stored Takara API key
- `miru setup` (Takara) **removes** any stored SageMaker endpoint

You do not need `--clear` when switching; the other mode is purged automatically.

## 1. Subscribe on AWS Marketplace

1. Open the [Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)
2. Subscribe to the DS1 model package for your region
3. Copy the **model package ARN** for your region from the listing page — it looks like:

```text
arn:aws:sagemaker:<region>:<account-id>:model-package/<name>
```

You'll pass this in as `ModelPackageArn` in step 2.

## 2. Deploy the endpoint (CloudFormation or CDK)

The supported way to deploy the endpoint is the template in
[`examples/sagemaker-marketplace`](../examples/sagemaker-marketplace), from a clean AWS account with no
prior SageMaker/Marketplace setup beyond the subscription above. Pick CloudFormation or CDK — both
templates create the same resources and outputs.

### Parameters

| Parameter              | Required | Default          | Description                                                                                                                         |
| ----------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelPackageArn`       | Yes      | —                 | ARN of the subscribed DS1 Marketplace model package from step 1                                                                       |
| `EndpointName`          | No       | `ds1-endpoint`    | Name for the SageMaker endpoint                                                                                                       |
| `InstanceType`          | No       | `ml.c5.xlarge`    | SageMaker instance type for the endpoint                                                                                              |
| `InitialInstanceCount`  | No       | `1`               | Number of instances for the production variant                                                                                       |
| `Region`                | Yes      | —                 | Region you're deploying into. Doesn't change where the stack deploys — it's a cross-check that must match `ModelPackageArn`'s region and your `--region`/profile |

### What it creates

- **`SageMakerExecutionRole`** (IAM role) — assumed by the SageMaker service to run the endpoint; scoped
  to writing its own CloudWatch log group only
- **`Model`** — SageMaker model pointing at the Marketplace model package, with network isolation enabled
- **`EndpointConfig`** — production variant using `InstanceType` / `InitialInstanceCount`
- **`Endpoint`** — the running SageMaker real-time endpoint

### Outputs

| Output              | Use                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `EndpointArn`         | Pass to `miru setup --sagemaker --arn …` in step 4                  |
| `ExecutionRoleArn`    | The endpoint's IAM role (informational; not used by `miru setup`)  |
| `EndpointNameOut`     | Endpoint name                                                       |
| `RegionOut`           | Region the stack deployed into — should match `Region`              |

### Deploy with CloudFormation

```bash
aws cloudformation deploy \
  --template-file examples/sagemaker-marketplace/cloudformation/sagemaker-marketplace-endpoint.yml \
  --stack-name ds1-sagemaker-endpoint \
  --region <region> \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ModelPackageArn=arn:aws:sagemaker:<region>:<account-id>:model-package/<name> \
    Region=<region>

aws cloudformation describe-stacks \
  --stack-name ds1-sagemaker-endpoint \
  --region <region> \
  --query "Stacks[0].Outputs"
```

### Deploy with CDK

```bash
cd examples/sagemaker-marketplace/cdk
npm install
npx cdk deploy \
  --parameters ModelPackageArn=arn:aws:sagemaker:<region>:<account-id>:model-package/<name> \
  --parameters Region=<region>
```

`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` are set automatically from your AWS credentials/profile —
confirm they match the region your `ModelPackageArn` was issued for. Outputs are printed after deploy
completes, or re-fetch them any time with:

```bash
aws cloudformation describe-stacks \
  --stack-name SageMakerMarketplaceEndpointStack \
  --region <region> \
  --query "Stacks[0].Outputs"
```

### Advanced: manual deployment

If you can't use CloudFormation/CDK, you can create the execution role, model, endpoint config, and
endpoint by hand (console or `aws sagemaker create-*` calls) — mirror the resources and settings in
[`sagemaker-marketplace-endpoint.yml`](../examples/sagemaker-marketplace/cloudformation/sagemaker-marketplace-endpoint.yml)
exactly, since Miru's setup and error messages assume that shape. This path is unsupported and untested
against Miru — prefer the template.

## 3. Create an invoke-only AWS profile (admin runbook)

This is separate from the endpoint's execution role above — it's the identity **you or your CI** use to
call the endpoint from `miru setup` / indexing / search. You need an AWS identity that can call
`sagemaker:InvokeEndpoint` on the endpoint ARN from step 2. The simplest path for a laptop / CI user is a
**least-privilege IAM user** scoped to that one endpoint, installed as a named profile.

From a checkout of this repo, with the [AWS CLI](https://docs.aws.amazon.com/cli/) available and **admin**
credentials in your current shell:

```bash
bun run sagemaker:create-invoke-user -- \
  --endpoint-arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name> \
  --profile miru
```

That script (`scripts/create-sagemaker-invoke-user.ts`):

1. Creates an IAM user tagged for this purpose (or reuses one with the same name)
2. Attaches an inline policy allowing **only** `sagemaker:InvokeEndpoint` on that ARN
3. Creates an access key and writes it into `~/.aws` as the named profile (`miru` by default)

Optional flags: `--user-name <name>`, `--profile <name>` (alias: `--arn` for the endpoint).

Prefer SSO / IAM roles in production if your org requires it — the runbook script is the easy start with
long-lived keys. Rotate or delete keys when someone leaves.

Smoke-test invoke (optional):

```bash
bun run sagemaker:auth-check -- --arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>
```

## 4. Point Miru at the endpoint

```bash
miru setup --sagemaker \
  --arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name> \
  --profile miru
```

Use the `EndpointArn` output from step 2 and the profile from step 3. Or run `miru setup --sagemaker` and
answer the prompts.

**What setup does**

1. Parses the endpoint ARN + AWS profile name
2. Invokes the endpoint once to confirm auth and that it returns embeddings
3. Saves the SageMaker config and **deletes any stored Takara API key**

After that, indexing and search embed via SageMaker — no egress to `infer.takara.ai`.

If `TAKARA_API_KEY` is still set in your shell or `.env.local`, remove it there too so it cannot conflict later.

## Switch back to Takara

```bash
miru setup
```

Enter your Takara API key. Setup validates it, saves it, and **deletes any stored SageMaker endpoint**.

Also unset any `MIRU_SAGEMAKER_*` variables if you set them in the environment or `.env.local`.

## Environment alternatives

Prefer `miru setup --sagemaker` so auth is checked automatically. You can also set:

| Variable                                                 | Purpose                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `MIRU_SAGEMAKER_ENDPOINT_ARN`                            | `arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>` |
| `MIRU_SAGEMAKER_ENDPOINT_NAME` + `MIRU_SAGEMAKER_REGION` | Alternative to the ARN                                    |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / …                  | Standard AWS credential chain                             |

Optional TEI-style knobs: `MIRU_SAGEMAKER_NORMALIZE`, `MIRU_SAGEMAKER_TRUNCATE`, `MIRU_SAGEMAKER_TRUNCATION_DIRECTION`, `MIRU_SAGEMAKER_PROMPT_NAME`.

See `miru help setup` and `miru -h` for the same flags in the CLI.
