# SageMaker access via IAM Identity Center

Use this page if your users are managed in Entra ID, Okta or another IdP and federated into AWS through IAM Identity Center. It replaces the invoke-only IAM user step of the [self-hosted SageMaker guide](self-hosted-sagemaker.md) - no IAM users or static access keys are created.

Prerequisite: the endpoint is deployed (step 1 of that guide) and you have its ARN.

## How it fits together

| Identity | Where it lives | What it does |
| -------- | -------------- | ------------ |
| SageMaker execution role | Endpoint account | Lets the SageMaker service pull the container and write logs. No people use it. Created in step 1. |
| `MiruInvoke` permission set | Identity Center | Grants `sagemaker:InvokeEndpoint` on one endpoint and nothing else. Assigned to a group. |
| Developer | Your IdP | Logs in with `aws sso login`, receives short-lived credentials for `MiruInvoke`, runs Miru. |

Joiner/leaver, MFA and Conditional Access stay in your IdP. Miru just uses the resulting session.

## Platform team: one-time setup

Work in the Identity Center region (it lives in exactly one region; the endpoint region does not need to match).

**1. Create a permission set.** Identity Center → Permission sets → Create → Custom. Name it `MiruInvoke`, attach no managed policies, and set this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sagemaker:InvokeEndpoint",
      "Resource": "arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>"
    }
  ]
}
```

Session duration is your call; 1 hour is a reasonable default. The endpoint name in the policy must match the deployed endpoint exactly - a mismatch produces an AccessDenied that looks like an SSO problem.

**2. Assign it.** Identity Center → AWS accounts → the account holding the endpoint → Assign users or groups → your developer group (e.g. `miru-users`) → `MiruInvoke` → Submit.

**3. Check provisioning.** On the permission set's "AWS accounts" tab the endpoint account should show as provisioned / up to date. "Not provisioned" means the assignment was not applied - select the account there and choose Provision, or run:

```bash
aws sso-admin provision-permission-set \
  --instance-arn <instance-arn> \
  --permission-set-arn <permission-set-arn> \
  --target-type AWS_ACCOUNT --target-id <account-id>
```

Provisioning creates a role named `AWSReservedSSO_MiruInvoke_<hash>` in the endpoint account. That role is what developers assume.

### Or: deploy it with CloudFormation

[`examples/sagemaker-marketplace/cloudformation/miru-identity-center.yml`](../examples/sagemaker-marketplace/cloudformation/miru-identity-center.yml) creates the permission set, the inline policy and the group assignment in one stack, and provisions the account as part of creation. Deploy it in the management (or delegated Identity Center admin) account, in the Identity Center region:

```bash
aws cloudformation deploy \
  --region <identity-center-region> \
  --stack-name miru-identity-center \
  --template-file examples/sagemaker-marketplace/cloudformation/miru-identity-center.yml \
  --parameter-overrides \
    InstanceArn=arn:aws:sso:::instance/ssoins-xxxx \
    GroupId=<group-id> \
    EndpointAccountId=<account-id> \
    EndpointArn=arn:aws:sagemaker:<region>:<account-id>:endpoint/<name>
```

The group must already exist in Identity Center (for federated setups, the group synced from your IdP). Deleting the stack removes the assignment and the permission set.

## Developers: per-machine setup

Requires the AWS CLI v2 and Miru 1.5.0 or later.

```bash
# Install or update Miru
bun add -g @takara-ai/miru-code
miru --version

# Create an SSO profile. Log in as yourself when the browser opens,
# choose the endpoint account and the MiruInvoke role, and name the profile "miru".
aws configure sso

# Confirm you are the SSO role in the right account
aws sts get-caller-identity --profile miru

# Point Miru at the endpoint
miru setup --sagemaker --arn <endpoint-arn> --profile miru
```

`aws configure sso` writes an `sso-session` block and a `[profile miru]` block to `~/.aws/config`. No keys are stored anywhere.

If the account does not appear in the picker, either you logged in as a user without the assignment, or the login pre-dates provisioning. Run `aws sso logout` and `aws configure sso` again.

## When the session expires

Miru resolves credentials through the standard AWS SDK chain, so it behaves like the AWS CLI:

- While the SSO session is valid, role credentials refresh automatically.
- Once it expires, searches fail until you run `aws sso login --profile miru`. Nothing needs reconfiguring.
- An MCP server (Claude Code, Cursor) that started while the session was expired needs a restart after logging in - in Claude Code, `/mcp` then reconnect.

## CI and other non-interactive use

Do not create an IAM user for CI. Use an IAM role in the endpoint account with the same `sagemaker:InvokeEndpoint` policy, trusted by your CI provider's OIDC identity (GitHub Actions, GitLab, etc.), and give Miru that profile via `AWS_PROFILE` or the environment variables in the main guide.

## Keeping client traffic private

Callers reach the endpoint through the SageMaker Runtime API. If developer or CI traffic must stay off the public internet, add a `sagemaker.runtime` interface endpoint in the VPC they connect through. Miru needs no changes; the SDK picks it up via DNS.
