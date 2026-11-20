FROM oven/bun:1.3.11
WORKDIR /var/task
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY grammars ./grammars
COPY examples/cockroachdb-shared-index/lambda.ts ./examples/cockroachdb-shared-index/lambda.ts
ENTRYPOINT ["/usr/local/bin/bun", "examples/cockroachdb-shared-index/lambda.ts"]
