# Miru (見る)

Hybrid code search for AI agents — **TypeScript**, **Bun**, and **Takara embeddings**.

*Miru* means “to see” or “to look” in Japanese — semantic search that helps agents find code by meaning.

Indexes a local directory, combines semantic search with BM25, RRF fusion, and code-tuned reranking.

## Install

Requires [Bun](https://bun.sh) 1.1+ on your PATH (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Run once without installing
bun x @takara-ai/miru-code search "auth middleware" ./src

# Global CLI
bun add -g @takara-ai/miru-code
miru search "auth middleware" ./src

# Library
bun add @takara-ai/miru-code
```

```ts
import { MiruIndex } from "@takara-ai/miru-code";

const index = await MiruIndex.fromPath("./src");
```

## Setup

```bash
bun install
```

Add credentials to `.env.local` (loaded automatically when you run from this repo), or pass them in your MCP config `env` block (recommended for Cursor — MCP does not inherit IDE env vars reliably).

| Variable | Default |
|----------|---------|
| `TAKARA_API_KEY` / `OPENAI_API_KEY` / `MIRU_OPENAI_API_KEY` | (required) Bearer token for Takara |
| `MIRU_OPENAI_BASE_URL` | `https://infer.dev.takara.ai/v1` |
| `MIRU_OPENAI_EMBEDDING_MODEL` | `ds1-potion-code-16m` |
| `MIRU_EMBEDDING_DIMENSIONS` | `256` (auto for potion) |
| `MIRU_FLOAT_VECTORS` | unset (default **int8** quantized vectors); set `1` for float32 |
| `MIRU_EMBEDDING_BATCH_SIZE` | `32` (max for this model) |
| `MIRU_CONCURRENCY` | logical CPUs **minus 2** (min 1) |

`SEMBLE_*` env names are still accepted as aliases for migration.

Parallelism: file reads/chunking, embedding batches (up to concurrency in flight), query embed overlapping BM25, and **BM25 scoring in Bun workers** (shards by doc range when index has 256+ chunks). BM25 uses an inverted postings list for fast single-threaded search on small indexes. Override with `MIRU_CONCURRENCY`.

`OPENAI_*` env aliases are also accepted where noted in the CLI help.

## CLI

```bash
# Hybrid search (positional, Python-compatible)
bun run miru search "where are embeddings created" ./src -k 5

# Find semantically related chunks
bun run miru find-related src/embeddings/openai.ts 120 ./src

# Write a miru-code sub-agent for Cursor / Claude / etc.
bun run miru init --agent cursor

# Clear disk cache
bun run miru clear ./src
```

Indexes are cached under `~/Library/Caches/miru` (macOS) or `~/.cache/miru` (Linux).

## MCP server

Run with **no arguments** to start the stdio MCP server. It indexes the **current working directory** (Cursor sets this to your workspace). Optional path/ref flags pre-index a different repo.

```bash
bun /path/to/miru/src/cli.ts
# or after bun add -g @takara-ai/miru-code:  miru
# or without installing:           bun x @takara-ai/miru-code
```

**Tools:** `search`, `find_related` — pass `repo` only when querying a different path or git URL.

Cursor `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

Use **`bun x`** (not `bunx` as the command) so Cursor does not pull the `bun` npm package postinstall, which breaks in MCP sandboxes:

```json
{
  "mcpServers": {
    "miru": {
      "command": "bun",
      "args": ["x", "@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token",
        "MIRU_OPENAI_BASE_URL": "https://infer.dev.takara.ai/v1",
        "MIRU_OPENAI_EMBEDDING_MODEL": "ds1-potion-code-16m",
        "MIRU_EMBEDDING_DIMENSIONS": "256"
      }
    }
  }
}
```

Alternatively, after `bun add -g @takara-ai/miru-code`:

```json
{
  "mcpServers": {
    "miru": {
      "command": "miru",
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

Local development (path to this repo):

```json
{
  "mcpServers": {
    "miru": {
      "command": "bun",
      "args": ["/absolute/path/to/miru/src/cli.ts"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

No project path in `args` for `bun x` / global install — Cursor runs the server with `cwd` set to the open workspace, which becomes the default index. Put the bearer token in `env`; MCP will not read `.env.local` unless those vars are unset.

## Library

```ts
import { MiruIndex } from "@takara-ai/miru-code";

const index = await MiruIndex.fromPath("./src");
const results = await index.search({ query: "BM25 tokenize", topK: 10 });
```

## Tests

```bash
bun test
bun run typecheck
```

## Publishing

Releases use **Bun** for install, test, and `bun pm pack`. The registry upload uses **`npm publish`** on that tarball because [Bun does not yet support npm OIDC trusted publishing](https://github.com/oven-sh/bun/issues/22423) — no long-lived npm tokens in GitHub secrets.

**Local first publish** (creates the package on npm):

```bash
bun publish --access public
```

**CI** (after Trusted Publisher is configured on npm):

```bash
npm version patch
git push && git push --tags
gh release create v0.1.1 --generate-notes
```

The `release.yml` workflow runs when the GitHub Release is published.

## License

MIT
