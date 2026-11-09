# Self-hosted embeddings (AWS SageMaker)

Run Miru against your own SageMaker embedding endpoint instead of Takara's hosted API (`infer.takara.ai`).

The embedding model is sold on AWS Marketplace:

**[Takara DS1 Miru (int8) — AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)**

## Overview

| Step | Who       | What                                                                          |
| ---- | --------- | ------------------------------------------------------------------------------ |
| 1    | AWS admin | Subscribe on Marketplace                                                       |
| 2    | AWS admin | Deploy the endpoint with the CloudFormation/CDK template (below)               |
| 3    | AWS admin | Create an invoke-only IAM user / profile or IAM Identity Center permission set |
| 4    | Developer | [Configure the Claude Code plugin or CLI](#4-point-miru-at-the-endpoint) with the endpoint and AWS profile |

Miru **never** creates IAM users, IAM roles, SageMaker resources, or writes `~/.aws`. It only inherits a profile you already have and checks that it can call the endpoint.

## One mode at a time

The CLI stores **either** Takara credentials **or** a SageMaker endpoint — never both.

- `miru setup --sagemaker …` **removes** any stored Takara API key
- `miru setup` (Takara) **removes** any stored SageMaker endpoint

You do not need `--clear` when switching; the other mode is purged automatically.

For Claude Code, use the [plugin settings](#claude-code-plugin). Its endpoint setting overrides stored Takara credentials without deleting them; clearing the setting returns the plugin to Takara. CLI setup does not configure the plugin.

### Codex plugin

After installing the plugin, ask Codex:

```text
Switch Miru to SageMaker endpoint
arn:aws:sagemaker:eu-west-2:123456789012:endpoint/miru
using my existing AWS profile miru-team.
```

Codex can call `auth` with `action: "sagemaker"`, `endpoint_arn`, and `aws_profile`. The tool checks the
ARN and invokes the endpoint to validate access before replacing stored credentials. If validation
fails, the current configuration stays active. AWS credentials must already be available to the
local MCP process; for an SSO profile, sign in with `aws sso login --profile <name>` first.

The configuration is saved in the installed plugin's data directory, so it survives MCP restarts.
Running `miru setup --sagemaker` in a separate terminal normally uses the CLI's global credentials
directory instead; it does not change a plugin with its own data directory.

The next search reloads the index for the configured endpoint. No AWS resources or profiles are
created. Claude Code also offers endpoint ARN and AWS profile fields in its plugin settings.

## 1. Subscribe on AWS Marketplace

1. Open the [Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)
2. Subscribe to the DS1 model package for your region
3. Copy the **model package ARN** for your region from the listing page — it looks like:

```text
arn:aws:sagemaker:<region>:<account-id>:model-package/<name>
```

You'll pass this in as `ModelPackageArn` in step 2.

## 2. Deploy the endpoint (CloudFormation or CDK)

From a checkout of this repository, use the CloudFormation or CDK template in
[`examples/sagemaker-marketplace`](../examples/sagemaker-marketplace). Deploy into the account entitled
to use the Marketplace subscription. Use an AWS deployment profile for that account. The identity
provisioning the stack needs permission to create the IAM role and SageMaker resources and to pass
the execution role to SageMaker (`iam:PassRole`). For CDK, check that the bootstrap execution role has
those permissions. Install AWS CLI v2, plus Node.js and npm if using CDK.

### Parameters

| Parameter              | Required | Default          | Description                                                                                                                         |
| ----------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelPackageArn`       | Yes      | —                 | ARN of the subscribed DS1 Marketplace model package from step 1                                                                       |
| `EndpointName`          | No       | `ds1-endpoint`    | Name for the SageMaker endpoint                                                                                                       |
| `InstanceType`          | No       | `ml.c5.xlarge`    | SageMaker instance type for the endpoint                                                                                              |
| `InitialInstanceCount`  | No       | `1`               | Number of instances for the production variant                                                                                       |
| `Region`                | Yes      | —                 | Expected region recorded as a tag. The templates do not validate it or use it to select the deployment region. |

Before deploying, compare the region in `ModelPackageArn` with the actual CloudFormation or CDK
target. Choose a real-time instance type supported by the package and check your SageMaker endpoint
quota in that region. Use a distinct `EndpointName` (up to 37 characters) for each stack in the same
account, even across regions, because the derived IAM role name is account-wide.

### What it creates

- **`SageMakerExecutionRole`** (IAM role) — assumed by the SageMaker service to run the endpoint; scoped
  to writing its own CloudWatch log group only
- **`Model`** — SageMaker model pointing at the Marketplace model package, with network isolation enabled
- **`EndpointConfig`** — production variant using `InstanceType` / `InitialInstanceCount`
- **`Endpoint`** — the running SageMaker real-time endpoint

### Outputs

| Output              | Use                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `EndpointArn`         | Use in the plugin settings or CLI setup in step 4                  |
| `ExecutionRoleArn`    | SageMaker service execution role (informational only)  |
| `EndpointNameOut`     | Endpoint name                                                       |
| `RegionOut`           | Region the stack deployed into — should match `Region`              |

### Deploy with CloudFormation

Set `DEPLOY_PROFILE`, `DEPLOY_REGION`, and `MODEL_PACKAGE_ARN` to your deployment values before running these commands.

```bash
aws cloudformation deploy \
  --template-file examples/sagemaker-marketplace/cloudformation/sagemaker-marketplace-endpoint.yml \
  --stack-name ds1-sagemaker-endpoint \
  --profile "$DEPLOY_PROFILE" \
  --region "$DEPLOY_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ModelPackageArn="$MODEL_PACKAGE_ARN" \
    Region="$DEPLOY_REGION"

aws cloudformation describe-stacks \
  --stack-name ds1-sagemaker-endpoint \
  --profile "$DEPLOY_PROFILE" \
  --region "$DEPLOY_REGION" \
  --query "Stacks[0].Outputs"
```

### Deploy with CDK

Use the same three variables as above. Set the deployment profile’s default region to
`DEPLOY_REGION` before running CDK.

```bash
cd examples/sagemaker-marketplace/cdk
npm install
npx cdk deploy --profile "$DEPLOY_PROFILE" \
  --parameters ModelPackageArn="$MODEL_PACKAGE_ARN" \
  --parameters Region="$DEPLOY_REGION"
```

Check that the account and region shown by CDK match your target. If the environment needs bootstrapping,
run `npx cdk bootstrap --profile "$DEPLOY_PROFILE"` and retry. Re-fetch the deployment outputs with:

```bash
aws cloudformation describe-stacks \
  --stack-name SageMakerMarketplaceEndpointStack \
  --profile "$DEPLOY_PROFILE" \
  --region "$DEPLOY_REGION" \
  --query "Stacks[0].Outputs"
```

### Advanced: manual deployment

If you can't use CloudFormation/CDK, you can create the execution role, model, endpoint config, and
endpoint by hand (console or `aws sagemaker create-*` calls). It must accept Miru's embedding request and
return embeddings; this path has less coverage, so prefer the template.

## 3. Create an invoke-only AWS profile (admin runbook)

This is separate from the endpoint's execution role above — it's the identity **you or your CI** use to
call the endpoint from `miru setup` / indexing / search. You need an AWS identity that can call
`sagemaker:InvokeEndpoint` on the endpoint ARN from step 2. The invoking credentials must resolve to
an identity in the endpoint's AWS account. SageMaker Runtime uses the caller's account and the
endpoint name to select the endpoint. Miru takes the runtime region from the endpoint ARN. The simplest path for a laptop / CI user is a
**least-privilege IAM user** scoped to that one endpoint, installed as a named profile.
Organizations using IAM Identity Center should use the [federated access guide](self-hosted-sagemaker-identity-center.md) instead. It avoids long-lived IAM users and access keys.

For the IAM user path, use a checkout of this repo with Bun, dependencies installed via `bun install`,
and AWS CLI v2. Run the provisioning command with admin credentials for the endpoint account.
Set `ENDPOINT_ARN` to the `EndpointArn` output:

```bash
bun run sagemaker:create-invoke-user -- \
  --endpoint-arn "$ENDPOINT_ARN" \
  --profile miru
```

That script (`scripts/create-sagemaker-invoke-user.ts`):

1. Creates an IAM user tagged for this purpose (or reuses one with the same name)
2. Attaches an inline policy allowing **only** `sagemaker:InvokeEndpoint` on that ARN
3. Creates an access key and writes it into `~/.aws` as the named profile (`miru` by default)

Optional flags: `--user-name <name>`, `--profile <name>` (alias: `--arn` for the endpoint).

Prefer SSO / IAM roles in production if your org requires it — the runbook script is the easy start with
long-lived keys. Rotate or delete keys when someone leaves.

### Smoke-test with the developer profile

Once the endpoint is `InService`, run these commands from the repository checkout with Bun and
dependencies installed. Set `ENDPOINT_ARN` to the stack output and use the same profile you will
configure in Miru. For an SSO profile, run `aws sso login --profile miru` first.

```bash
aws sts get-caller-identity --profile miru
AWS_PROFILE=miru bun run sagemaker:auth-check -- --arn "$ENDPOINT_ARN"
```

Use a shell without exported AWS access keys and confirm the caller account matches the endpoint ARN.
Expect `OK` with one embedding and a positive dimension count. This checks a single invocation.
Verify indexing and search in your chosen Miru client after configuration.

## 4. Point Miru at the endpoint

### Claude Code plugin

This is the recommended setup for Claude Code. [Install the Claude Code plugin](../README.md#claude-code-recommended) first. After steps 1–3, run `/plugin` inside Claude Code, open **miru**, and set:

| Setting                  | Value                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `SageMaker endpoint ARN` | The `EndpointArn` output from step 2                                                     |
| `AWS profile`            | The profile from step 3. It must already exist in `~/.aws`; Miru never creates one.       |

Restart Claude Code and ask it to search your project with Miru. No Miru CLI installation or `miru setup` step is needed.

When the ARN is set, it **takes priority over any stored Takara sign-in** and Miru does not contact `infer.takara.ai`. Nothing is deleted, so clearing the ARN returns you to Takara. Leaving the ARN blank means Takara is used. The profile is only read when an ARN is set.

If the profile uses SSO, run `aws sso login --profile <name>` again whenever the token expires.

### CLI (fallback)

Use this when running Miru from a terminal or installing an IDE integration through the CLI. These credentials are separate from the Claude Code plugin's settings.

```bash
miru setup --sagemaker \
  --arn "$ENDPOINT_ARN" \
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

In the Claude Code plugin, clear the **SageMaker endpoint ARN** setting and restart. Sign in through Miru's `auth` tool if prompted.

For the CLI:

```bash
miru setup
```

Enter your Takara API key. Setup validates it, saves it, and **deletes any stored SageMaker endpoint**.

Also unset any `MIRU_SAGEMAKER_*` variables if you set them in the environment or `.env.local`.

## Environment alternatives

For the CLI, prefer `miru setup --sagemaker` so auth is checked automatically. You can also set:

| Variable                                                 | Purpose                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `MIRU_SAGEMAKER_ENDPOINT_ARN`                            | `arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>` |
| `MIRU_SAGEMAKER_ENDPOINT_NAME` + `MIRU_SAGEMAKER_REGION` | Alternative to the ARN                                    |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / …                  | Standard AWS credential chain                             |

Optional TEI-style knobs: `MIRU_SAGEMAKER_NORMALIZE`, `MIRU_SAGEMAKER_TRUNCATE`, `MIRU_SAGEMAKER_TRUNCATION_DIRECTION`, `MIRU_SAGEMAKER_PROMPT_NAME`.

See `miru help setup` and `miru -h` for the same flags in the CLI.
