# Miru (見る)

Hybrid code search for AI agents — **TypeScript**, **Bun**, and **Takara embeddings**.

## What is Miru?

*Miru* (見る) means “to see” or “to look” in Japanese. Miru helps coding agents **find code by meaning** instead of guessing file paths or running exhaustive greps.

When an agent asks “where is auth middleware configured?” or “how do we batch embeddings?”, Miru returns the most relevant **chunks** of your codebase — file path, line range, and snippet — so the agent can read only what matters.

### Why hybrid search?

Pure semantic search misses exact symbol matches. Pure keyword search misses paraphrased intent. Miru combines both:

1. **Dense (semantic)** — Takara code embeddings (`ds1-potion-code-16m`) over structurally chunked source files.
2. **Sparse (BM25)** — keyword scoring with an inverted index; parallelized in Bun workers on large repos.
3. **RRF fusion** — reciprocal rank fusion merges the two ranked lists.
4. **Reranking** — code-tuned penalties and boosts (e.g. multi-chunk files, query-term overlap).

Indexes are built on demand, cached on disk, and invalidated when files change. You can search **code**, **docs**, **config**, or **all** content types.

### How agents use Miru

| Mode | Best for | What the agent gets |
|------|----------|---------------------|
| **MCP server** | Cursor, Claude Code, VS Code Copilot, Gemini CLI, Kiro, OpenCode | Native `search` and `find_related` tools over the workspace |
| **CLI sub-agent** | Any agent with shell access | `miru init --agent <id>` writes a specialist agent that runs `miru search` / `miru find-related` via Bash |

Both modes share the same index and cache. Pick MCP when your IDE supports it; use the sub-agent when you want a dedicated exploration agent without MCP wiring.

## Install

Requires [Bun](https://bun.sh) 1.1+ on your PATH (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Run once without installing
bunx @takara-ai/miru-code search "auth middleware" ./src

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

Add credentials to `.env.local` (loaded automatically when you run from this repo), or pass them in your MCP config `env` block (recommended — MCP does not inherit IDE env vars reliably).

| Variable | Default |
|----------|---------|
| `TAKARA_API_KEY` | (required) Takara bearer token for embeddings |
| `MIRU_OPENAI_BASE_URL` | `https://infer.dev.takara.ai/v1` |
| `MIRU_OPENAI_EMBEDDING_MODEL` | `ds1-potion-code-16m` |
| `MIRU_EMBEDDING_DIMENSIONS` | `256` (auto for potion) |
| `MIRU_FLOAT_VECTORS` | unset (default **int8** quantized vectors); set `1` for float32 |
| `MIRU_EMBEDDING_BATCH_SIZE` | `32` (max for this model) |
| `MIRU_CONCURRENCY` | logical CPUs **minus 2** (min 1) |

Parallelism: file reads/chunking, embedding batches (up to concurrency in flight), query embed overlapping BM25, and **BM25 scoring in Bun workers** (shards by doc range when index has 256+ chunks). BM25 uses an inverted postings list for fast single-threaded search on small indexes. Override with `MIRU_CONCURRENCY`.

## IDE integration

Miru supports six agent platforms. For each, you can wire the **MCP server** (recommended) and/or install a **CLI sub-agent** with `miru init`.

### Quick reference

| IDE | MCP config file | Sub-agent command | Sub-agent output |
|-----|-----------------|-------------------|------------------|
| [Cursor](#cursor) | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `miru init --agent cursor` | `.cursor/agents/miru-code.md` |
| [Claude Code](#claude-code) | `.mcp.json` (project root) or `~/.claude.json` | `miru init --agent claude` | `.claude/agents/miru-code.md` |
| [VS Code / Copilot](#vs-code--github-copilot) | `.vscode/mcp.json` or user profile `mcp.json` | `miru init --agent copilot` | `.github/agents/miru-code.md` |
| [Gemini CLI](#gemini-cli) | `~/.gemini/settings.json` or `.gemini/settings.json` | `miru init --agent gemini` | `.gemini/agents/miru-code.md` |
| [Kiro](#kiro) | `~/.kiro/settings/mcp.json` or `.kiro/settings/mcp.json` | `miru init --agent kiro` | `.kiro/agents/miru-code.md` |
| [OpenCode](#opencode) | `~/.config/opencode/opencode.json` or `opencode.json` | `miru init --agent opencode` | `.opencode/agents/miru-code.md` |

Run `miru init --agent <id> --force` to overwrite an existing sub-agent file.

### MCP server

Run with **no arguments** to start the stdio MCP server. Indexing begins on the first `search` or `find_related` call, using the `repo` path you pass. Optional `--ref` sets the default git ref for remote repos.

```bash
bunx @takara-ai/miru-code
# or after bun add -g @takara-ai/miru-code:  miru
```

**Tools:** `search`, `find_related` — `repo` is required (project root or https:// git URL).

For MCP configs, use `bunx` as the command (`bun` with `x` in `args` works too — they're equivalent).

Put the bearer token in `env`; MCP will not read `.env.local` unless those vars are unset.

#### Shared env block

Use this in every MCP config below (adjust the key name if your IDE uses `environment` instead of `env`):

```json
{
  "TAKARA_API_KEY": "your-takara-bearer-token",
  "MIRU_OPENAI_BASE_URL": "https://infer.dev.takara.ai/v1",
  "MIRU_OPENAI_EMBEDDING_MODEL": "ds1-potion-code-16m",
  "MIRU_EMBEDDING_DIMENSIONS": "256"
}
```

### Cursor

**MCP** — `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "miru": {
      "command": "bunx",
      "args": ["@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

After `bun add -g @takara-ai/miru-code`, you can use `"command": "miru"` instead.

**Sub-agent:**

```bash
miru init --agent cursor
```

Commit `.cursor/agents/miru-code.md` to share the exploration agent with your team.

### Claude Code

**MCP** — project `.mcp.json` (check into git) or user scope in `~/.claude.json`:

```json
{
  "mcpServers": {
    "miru": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "${TAKARA_API_KEY}"
      }
    }
  }
}
```

Claude Code supports `${VAR}` expansion in config files. Restart the session and run `/mcp` to verify the connection.

Or via CLI:

```bash
claude mcp add miru -s project -- bunx @takara-ai/miru-code
```

**Sub-agent:**

```bash
miru init --agent claude
```

Writes `.claude/agents/miru-code.md` — invoke the `miru-code` agent for semantic exploration tasks.

### VS Code / GitHub Copilot

**MCP** — workspace `.vscode/mcp.json` or user profile (Command Palette: **MCP: Open User Configuration**):

```json
{
  "servers": {
    "miru": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

VS Code uses `"servers"` (not `mcpServers`). Use **MCP: List Servers** to start or restart the server after editing the config.

**Sub-agent:**

```bash
miru init --agent copilot
```

Writes `.github/agents/miru-code.md` for Copilot’s agent system.

### Gemini CLI

**MCP** — `~/.gemini/settings.json` or project `.gemini/settings.json`:

```json
{
  "mcpServers": {
    "miru": {
      "command": "bunx",
      "args": ["@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

Or add interactively: `gemini mcp add`. Run `/mcp` inside a session to confirm tools are available.

**Sub-agent:**

```bash
miru init --agent gemini
```

Writes `.gemini/agents/miru-code.md`.

### Kiro

**MCP** — `~/.kiro/settings/mcp.json` or workspace `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "miru": {
      "command": "bunx",
      "args": ["@takara-ai/miru-code"],
      "env": {
        "TAKARA_API_KEY": "your-takara-bearer-token",
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Kiro runs with a minimal environment — include `PATH` if Bun is not on the default path. Approve env vars when prompted in the IDE.

**Sub-agent:**

```bash
miru init --agent kiro
```

Writes `.kiro/agents/miru-code.md`.

### OpenCode

**MCP** — `~/.config/opencode/opencode.json` or project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "miru": {
      "type": "local",
      "command": ["bunx", "@takara-ai/miru-code"],
      "enabled": true,
      "environment": {
        "TAKARA_API_KEY": "your-takara-bearer-token"
      }
    }
  }
}
```

OpenCode uses the `mcp` key (not `mcpServers`), requires `"type": "local"`, and uses `environment` instead of `env`. Verify with `opencode mcp list`.

**Sub-agent:**

```bash
miru init --agent opencode
```

Writes `.opencode/agents/miru-code.md` (subagent mode with bash/read permissions).

### Local development (any IDE)

Point MCP at this repo instead of the published package:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/miru-code/src/cli.ts"],
  "env": {
    "TAKARA_API_KEY": "your-takara-bearer-token"
  }
}
```

Merge into the appropriate wrapper key (`mcpServers`, `servers`, or `mcp`) for your IDE.

## CLI

```bash
# Hybrid search (positional, Python-compatible)
bun run miru search "where are embeddings created" ./src -k 5

# Find semantically related chunks
bun run miru find-related src/embeddings/openai.ts 120 ./src

# Write a miru-code sub-agent for your IDE
bun run miru init --agent cursor

# Clear disk cache
bun run miru clear ./src
```

Indexes are cached under `~/Library/Caches/miru` (macOS) or `~/.cache/miru` (Linux).

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

**Local publish** (logged in to npm; `publishConfig.access` is already `public`):

```bash
bun publish
```

Runs `prepublishOnly` (typecheck + tests), then a single registry upload. Do not add a `publish` script that calls `npm publish` — Bun runs lifecycle scripts after its own upload and would publish twice.

**CI** (after Trusted Publisher is configured on npm):

```bash
npm version patch
git push && git push --tags
gh release create v0.1.1 --generate-notes
```

The `release.yml` workflow runs when the GitHub Release is published.

## License

MIT
