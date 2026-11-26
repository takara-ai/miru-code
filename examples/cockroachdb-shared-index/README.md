# Miru shared index on CockroachDB

This opt-in integration is for the AWS BOX pilot. A CI writer uses Miru to chunk and hash tracked source before sending it to the router. The router calls ds1-code on SageMaker for missing embeddings, caches them by repository and content hash, and writes files and chunks atomically to CockroachDB. The retrieval queries check repository grants in SQL. CockroachDB returns bounded vector and lexical candidates, and the Miru client applies BM25 and hybrid reranking before returning repository and line citations to CLI and MCP users. Local Miru commands continue to work with their usual local index.

## Verify on a development database

Use Bun 1.4.5 or later and a disposable CockroachDB v25.4 or later database. The schema requires the vector index cluster setting.

```sh
cockroach sql --url "$MIRU_TEST_CRDB_URL" --file examples/cockroachdb-shared-index/schema.sql
bun test tests/cockroach-shared-index.test.ts
```

The integration test uses deterministic fixture embeddings with an actual database and HTTP router. It checks cross-repository result ordering, restricted repositories, tenant isolation, reader/writer permissions, embedding reuse, competing updates, interrupted Git sync, deletes and access revocation.

To run with an actual SageMaker endpoint on a developer machine, set `MIRU_SHARED_DATABASE_URL`, `MIRU_SHARED_MODEL_KEY`, `MIRU_SAGEMAKER_ENDPOINT_ARN` and `MIRU_SHARED_LOCAL_IDENTITIES`. The identity map keys are unique local bearer credentials at least 24 characters long. Values have the shape `{"tenant":"my-org","principal":"dev-alice"}`. Run `bun examples/cockroachdb-shared-index/local.ts`. Set `MIRU_SHARED_URL=http://127.0.0.1:8765` and `MIRU_SHARED_LOCAL_TOKEN` in the client. The local router binds to loopback.

## Deploy the BOX pilot with CloudFormation

[`pilot.yml`](pilot.yml) is the parent stack. It deploys the existing SageMaker Marketplace and router templates as nested stacks, passes the model endpoint ARN to the router, and creates the private DNS interface endpoints for API Gateway, SageMaker Runtime and Secrets Manager. The router security group permits HTTPS to the service endpoints and SQL to the internal CockroachDB load balancer. The router's IAM role and the service endpoints restrict access to the model and database secret.

Before deployment, provision the customer VPC, Client VPN and identity configuration, and CockroachDB BYOC as specified in the BOX architecture. Use an internal load balancer with a security group in this VPC. Configure VPC DNS hostnames and resolution, private subnets in separate Availability Zones, and a client security group on the VPN association and CI runners. Use a VPC without conflicting private DNS endpoints for the three services. In a VPC with existing interface endpoints, follow the standalone router instructions below. Enabling private DNS for execute-api makes the default public API Gateway hostnames unavailable from that VPC.

Apply [schema.sql](schema.sql) and [roles.sql](roles.sql) as the database owner. Store the router role's `sslmode=verify-full` connection URL in Secrets Manager as a string, or as `{"url":"…","ca":"…"}` if a private CA is required. Use a database hostname covered by its certificate. Subscribe to the [ds1-code Marketplace package](../../docs/self-hosted-sagemaker.md) in the deployment region, and build and publish the router image by digest as shown below.

From the repository root, package and deploy the parent stack with a same-region deployment bucket. Set the environment variables to the pilot account's values. Keep the local principal map file outside source control.

```sh
aws cloudformation package \
  --region "$AWS_REGION" \
  --template-file examples/cockroachdb-shared-index/pilot.yml \
  --s3-bucket "$BOX_ARTIFACT_BUCKET" \
  --output-template-file /tmp/miru-box-packaged.yml

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$BOX_STACK" \
  --template-file /tmp/miru-box-packaged.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$BOX_VPC_ID" PrivateSubnets="$BOX_PRIVATE_SUBNETS" \
    ClientSecurityGroupId="$BOX_CLIENT_SECURITY_GROUP" \
    DatabaseSecurityGroupId="$BOX_DATABASE_SECURITY_GROUP" \
    DatabaseSecretArn="$BOX_DATABASE_SECRET_ARN" \
    DatabaseSecretKmsKeyArn="${BOX_DATABASE_SECRET_KMS_KEY_ARN:-}" \
    RouterImageUri="$BOX_ROUTER_IMAGE_URI" \
    ModelPackageArn="$BOX_MODEL_PACKAGE_ARN" ModelEndpointName="$BOX_MODEL_ENDPOINT_NAME" \
    ModelKey="$BOX_MODEL_KEY" PrincipalMap="$(cat "$BOX_PRINCIPAL_MAP_FILE")"
```

Use a comma-separated list for `BOX_PRIVATE_SUBNETS`. Override `ModelInstanceType` for the subscribed model package if required. Grant the mapped identities `execute-api:Invoke` on the stack's `InvokeResource` output. The Lambda matches the precise caller ARN from the API Gateway IAM context. Restrict who can assume mapped sessions, and verify the ARN emitted by each pilot identity.

### Run the AWS smoke test

Provision a fresh disposable repository row with the stack's model key, a write grant for the CI principal and a read grant for a separate developer principal. From a machine or runner that can reach the private API, select the CI credentials, set `MIRU_SHARED_URL` to the stack's `SharedIndexUrl` output, and run:

```sh
MIRU_SHARED_REGION="$AWS_REGION" MIRU_SMOKE_READER_PROFILE=box-developer \
  bash examples/cockroachdb-shared-index/smoke-pilot.sh example/box-smoke
```

The script indexes a synthetic Git file, checks that at least one embedding was generated, searches as the developer from an empty directory, verifies replay is a no-op, then deletes the file and checks search is empty. Use a new disposable repository ID for each run. The offline CI check packages the nested templates with Moto and verifies the Miru SageMaker SDK call against a fixture response. The deployed smoke test exercises AWS private networking, IAM and the real model.

## Deploy the router with existing infrastructure

1. Provision the existing [ds1-code SageMaker Marketplace endpoint](../../docs/self-hosted-sagemaker.md) and a private CockroachDB BYOC cluster. Follow your account's approved endpoint, VPN, security group, KMS, database backup and audit configuration. Put the runtime Lambda subnets, its security group and interface endpoints on routes to CockroachDB, SageMaker Runtime and Secrets Manager. Enable private DNS for the execute-api interface endpoint reachable by the laptop VPN and CI runner.
2. Run [schema.sql](schema.sql) and [roles.sql](roles.sql) as a database administrator. Give `miru_router` to the Lambda DB login and `miru_acl_sync` to the permission sync login. Use a URL with `sslmode=verify-full`. Put the Lambda URL in Secrets Manager as a string, or store `{"url":"…","ca":"…"}` for a private CA.
3. Build the Linux x86-64 container from the repository root and publish to a same-region ECR repository. Use a digest in `RouterImageUri`.

   ```sh
   docker build --platform linux/amd64 -f examples/cockroachdb-shared-index/Dockerfile -t "$ROUTER_IMAGE_TAG" .
   docker push "$ROUTER_IMAGE_TAG"
   ```

4. Deploy [router.yml](router.yml) with the endpoint ARN, subnets, router security group, execute-api VPC endpoint ID, DB secret ARN, model key and principal map. Grant each mapped AWS identity `execute-api:Invoke` against the `InvokeResource` output. The Lambda trusts the IAM identity in the API Gateway request context. The configured map uses **exact** caller ARNs, including the per-user Identity Center role session name or the dedicated CI role's session name. Verify the emitted ARN per pilot identity in the test account. Use an Identity Center trust policy and CI role trust policy that prevent callers from choosing another mapped session identity.
5. Provision repository rows with the same model key. Give `can_write` only to the repository's trusted ingestion identity. Give a developer a read grant or sync effective read access from GitHub. Repository IDs and grants are scoped to a tenant.

   ```sql
   INSERT INTO miru_repositories (tenant_id, repository_id, model_key)
   VALUES ('my-org', 'my-org/api', 'ds1-code-pinned-revision');
   INSERT INTO miru_repository_grants (tenant_id, repository_id, principal_id, can_write)
   VALUES ('my-org', 'my-org/api', 'ci-api', true);
   ```

6. Set `MIRU_SHARED_URL` to the `SharedIndexUrl` output and `MIRU_SHARED_REGION` to the deployment region. Use the normal AWS SDK credential chain. For developer laptops this can be an IAM Identity Center profile after `aws sso login`. For CI use short-lived assumed-role credentials.

### GitHub read grants

Use the GitHub App installation token, or another credential permitted to list effective repository collaborators. Supply a JSON mapping from immutable GitHub user IDs to the same principal IDs used by the IAM map. Run the sync job every five minutes from a trusted worker with GitHub and database access. A failed sync preserves the last successful snapshot until its 15-minute grants expire. Manual service grants have a separate lifecycle.

```sh
bun examples/cockroachdb-shared-index/sync-github-grants.ts my-org my-org/api ./principals.json
```

Set `GITHUB_TOKEN` and `MIRU_SHARED_ACL_DATABASE_URL` in the worker's secret configuration. For a private CA, trust it in the worker's runtime trust store.

### Ingest and search

```sh
miru shared sync-git my-org/api "$(git rev-parse HEAD)"
miru shared search "where is the OAuth token verified?" my-org/api my-org/worker
```

Run ingestion on the canonical branch with complete history. Bootstrap a fresh repository index from the canonical commit. CockroachDB stores the last completed commit and the active target. Retry an interrupted sync with its original target before moving forward. A replay of the completed target performs no writes. Stale targets and force-pushes are rejected. Binary blobs, symlinks and source files over 128 KB are omitted. If a previously indexed file becomes ineligible or disappears, the sync removes its chunks and retains its revision.

For a separate, non-Git repository index, use `miru shared revision`, `miru shared put` and `miru shared delete`. Updates and deletes require the expected previous revision, using `-` for a new file.

To search from an IDE, pass the same client configuration to the Miru MCP subprocess and use `search_shared` with `query` and a `repositories` array. The tool returns repository, path, line range, source text, and score. A headless agent can run the same CLI in an empty workspace.

### Compare embedding endpoints

```sh
bun examples/cockroachdb-shared-index/benchmark.ts ./labelled-public-fixtures.json
```

Use the JSON shape `{"documents":[{"id":"…","text":"…"}],"cases":[{"query":"…","relevant":["…"]}]}`. The command reports indexing time, warmed query p50/p95, recall@5 and MRR@5 on the same labels. Use a public or approved corpus for this comparison because it sends the same texts to the Takara API and SageMaker. Run the private-repository pilot against the customer endpoint.

### Pilot limits

The first implementation uses a single immutable 256-dimensional model version per repository, a canonical branch per repository, a 128 KB source-file cap, and up to 16 repositories per search. File updates are atomic individually. During a multi-file CI batch, readers can observe a mix of old and new file revisions. Simultaneous misses for the same chunk can each invoke SageMaker, though stored cache rows converge. Derived cached vectors remain until a database operator purges them or drops the repository's index. The principal map is intended for a small pilot and is subject to Lambda environment size limits. Exercise the customer's IAM, networking, index size, retention and security controls in the AWS test account before pilot data is loaded.
