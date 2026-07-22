# Self-hosted embeddings (AWS SageMaker)

Enterprise guide: run Miru against your own SageMaker embedding endpoint instead of Takara’s hosted API (`infer.takara.ai`).

The embedding model is sold on AWS Marketplace:

**[Takara DS1 Miru (int8) — AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue)**

Subscribe there, deploy the model package as a SageMaker endpoint in your account, then point Miru at that endpoint.

## One mode at a time

Miru stores **either** a Takara API key **or** a SageMaker endpoint — never both.

- `miru setup --sagemaker …` **removes** any stored Takara API key
- `miru setup` (Takara) **removes** any stored SageMaker endpoint

You do not need `--clear` when switching; the other mode is purged automatically.

## Prerequisites

- A SageMaker endpoint deployed from the [Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-la5olwsicr6ue) (e.g. `ds1-miru-int8` via `ds1-tei`)
- An AWS identity that can call `sagemaker:InvokeEndpoint` on that endpoint
- AWS CLI profile already configured (Miru never creates or writes `~/.aws`)

```bash
aws configure --profile miru
```

## Switch from Takara to SageMaker

```bash
miru setup --sagemaker \
  --arn arn:aws:sagemaker:<region>:<account-id>:endpoint/<name> \
  --aws-profile miru
```

Or run `miru setup --sagemaker` and answer the prompts.

**What setup does**

1. Parses the endpoint ARN + AWS profile name
2. Invokes the endpoint once to confirm auth and that it returns embeddings
3. Saves the SageMaker config and **deletes any stored Takara API key**

After a successful setup, indexing and search embed via SageMaker — no egress to `infer.takara.ai`.

If `TAKARA_API_KEY` is still set in your shell or `.env.local`, remove it there too so it cannot conflict later.

## Switch back to Takara

```bash
miru setup
```

Enter your Takara API key. Setup validates it, saves it, and **deletes any stored SageMaker endpoint**.

Also unset any `MIRU_SAGEMAKER_*` variables if you set them in the environment or `.env.local`.

## Environment alternatives

Prefer `miru setup --sagemaker` so auth is checked automatically. You can also set:

| Variable | Purpose |
| --- | --- |
| `MIRU_SAGEMAKER_ENDPOINT_ARN` | `arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>` |
| `MIRU_SAGEMAKER_ENDPOINT_NAME` + `MIRU_SAGEMAKER_REGION` | Alternative to the ARN |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / … | Standard AWS credential chain |

Optional TEI-style knobs: `MIRU_SAGEMAKER_NORMALIZE`, `MIRU_SAGEMAKER_TRUNCATE`, `MIRU_SAGEMAKER_TRUNCATION_DIRECTION`, `MIRU_SAGEMAKER_PROMPT_NAME`.

See `miru help setup` and `miru -h` for the same flags in the CLI.
