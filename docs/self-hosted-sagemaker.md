# Self-hosted embeddings (AWS SageMaker)

Run Miru against your own SageMaker embedding endpoint instead of Takara’s hosted API (`infer.takara.ai`).

The embedding model is sold on AWS Marketplace:

**[Takara DS1 Miru (int8) — AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)**

## Overview


| Step | Who       | What                                                             |
| ---- | --------- | ---------------------------------------------------------------- |
| 1    | AWS admin | Subscribe on Marketplace and deploy a SageMaker endpoint         |
| 2    | AWS admin | Create an invoke-only IAM user / profile (runbook below)         |
| 3    | Developer | `miru setup --sagemaker` — Miru validates and saves the endpoint |


Miru **never** creates IAM users or writes `~/.aws`. It only inherits a profile you already have and checks that it can call the endpoint.

## One mode at a time

Miru stores **either** a Takara API key **or** a SageMaker endpoint — never both.

- `miru setup --sagemaker …` **removes** any stored Takara API key
- `miru setup` (Takara) **removes** any stored SageMaker endpoint

You do not need `--clear` when switching; the other mode is purged automatically.

## 1. Deploy the Marketplace endpoint

1. Open the [Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)
2. Subscribe and deploy the model package as a SageMaker endpoint in your account
3. Copy the endpoint ARN — it looks like:

```text
arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>
```



## 2. Create an invoke-only AWS profile (admin runbook)

You need an AWS identity that can call `sagemaker:InvokeEndpoint` on that ARN. The simplest path for a laptop / CI user is a **least-privilege IAM user** scoped to that one endpoint, installed as a named profile.

From a checkout of this repo, with the [AWS CLI](https://docs.aws.amazon.com/cli/) available and **admin** credentials in your current shell:

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

Prefer SSO / IAM roles in production if your org requires it — the runbook script is the easy start with long-lived keys. Rotate or delete keys when someone leaves.

Smoke-test invoke (optional):

```bash
bun run sagemaker:auth-check -- --arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>
```



## 3. Point Miru at the endpoint

```bash
miru setup --sagemaker \
  --arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name> \
  --profile miru
```

Or run `miru setup --sagemaker` and answer the prompts.

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
| -------------------------------------------------------- | --------------------------------------------------------- |
| `MIRU_SAGEMAKER_ENDPOINT_ARN`                            | `arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>` |
| `MIRU_SAGEMAKER_ENDPOINT_NAME` + `MIRU_SAGEMAKER_REGION` | Alternative to the ARN                                    |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / …                  | Standard AWS credential chain                             |


Optional TEI-style knobs: `MIRU_SAGEMAKER_NORMALIZE`, `MIRU_SAGEMAKER_TRUNCATE`, `MIRU_SAGEMAKER_TRUNCATION_DIRECTION`, `MIRU_SAGEMAKER_PROMPT_NAME`.

See `miru help setup` and `miru -h` for the same flags in the CLI.
