# Miru (見る)

Hybrid code search for AI agents — **TypeScript**, **Bun**, and **Takara embeddings**.

## How to read this doc

| If you want to… | Start here |
|-----------------|------------|
| Use Miru in an IDE (Cursor, Claude Code, etc.) | [User flow](#user-flow) → [Credentials](#credentials) → [IDE integration](#ide-integration) |
| Run search from a terminal or script | [User flow](#user-flow) → [CLI](#cli) |
| Embed Miru in your own tool | [Library](#library) |
| Hack on this repo | [Developing Miru](#developing-miru) |

The sections below follow that order: **what Miru does**, **how you use it end to end**, then **reference** (CLI flags, env vars, per-IDE MCP JSON).

## What is Miru?

*Miru* (見る) means “to see” or “to look” in Japanese. Miru helps coding agents **find code by meaning** instead of guessing file paths or running exhaustive greps.

When an agent asks “where is auth middleware configured?” or “how do we batch embeddings?”, Miru returns the most relevant **chunks** — file path, line range, and snippet — so the agent can read only what matters.

### Why hybrid search?

Pure semantic search misses exact symbol matches. Pure keyword search misses paraphrased intent. Miru combines both:

1. **Dense (semantic)** — Takara code embeddings (`ds1-potion-code-16m`) over structurally chunked source files.
2. **Sparse (BM25)** — keyword scoring with an inverted index; parallelized in Bun workers when the index has 256+ chunks.
3. **RRF fusion** — reciprocal rank fusion merges the two ranked lists.
4. **Reranking** — code-tuned penalties and boosts (e.g. multi-chunk files, query-term overlap).

You can index **code**, **docs**, **config**, or **all** of the above via `--content` (CLI/MCP) or when building an index in the library.

### Caching (what “fresh” means)

| Layer | Behavior |
|-------|----------|
| **First search** | Builds an index (chunk → embed → BM25 + vectors), then writes a disk cache. |
| **MCP server (local repo, same session)** | Watches the workspace and **incrementally** re-indexes changed files; updates the disk cache. Disable with `MIRU_MCP_WATCH=0`. |
| **CLI or a new MCP session** | Reuses the disk cache if the embedding model, content types, and indexed files still match. Cache does **not** detect file edits by itself — run `miru clear <path>` after large changes, or rely on MCP live updates. |
| **Remote `https://` repos** | Cloned per session; no filesystem watch. Use `--ref` for a branch/tag. |

Cache locations: `~/Library/Caches/miru` (macOS), `~/.cache/miru` (Linux), `%LOCALAPPDATA%\miru\Cache` (Windows).

### How agents use Miru

| Mode | Best for | What the agent gets |
|------|----------|---------------------|
| **MCP server** | Cursor, Claude Code, VS Code Copilot, Gemini CLI, Kiro, OpenCode | `search` and `find_related` tools; pass `repo` (local path or `https://` git URL) |
| **CLI sub-agent** | Any agent with shell access | `miru install` (global) or `miru init --agent <id>` (per-repo) |

Both modes share the same indexing logic and disk cache layout.

## User flow

Typical path from zero to useful search:

```text
1. Install Bun + Miru          →  bun add -g @takara-ai/miru-code   (or bunx for one-off)
2. Credentials                 →  miru setup   OR   TAKARA_API_KEY in MCP env / .env.local
3. Integrate                   →  miru install   (MCP + instructions + sub-agent)
4. Search                        →  Agent calls search("…", repo: project root)
5. Go deeper (optional)        →  find_related(file, line) on a hit
6. Refresh cache (if needed)   →  miru clear .   after big refactors when using CLI only
```

**Agent workflow:** `search` first → read returned chunks → `find_related` on a promising `file_path` + line → open full files only when the chunk is not enough → use grep for exhaustive literal matches.

**`repo` rules:** Local workspaces use the **project root** path. Remote repos use an explicit **`https://` or `http://`** URL (not `git@` SSH). Never guess URLs.

## Install

Requires [Bun](https://bun.sh) 1.1+ on your PATH.

```bash
# One-off
bunx @takara-ai/miru-code search "auth middleware" ./src

# Global CLI
bun add -g @takara-ai/miru-code
miru search "auth middleware" ./src

# Library
bun add @takara-ai/miru-code
```

## Credentials

Miru needs a **Takara bearer token** for embeddings (`TAKARA_API_KEY`).

**CLI / terminal (recommended for local dev):**

```bash
miru setup              # interactive; validates key and stores locally
miru setup --key TOKEN  # non-interactive
miru setup --clear      # remove stored key
```

Stored at `~/Library/Application Support/miru/credentials.json` (macOS), `~/.config/miru/` (Linux), or `%APPDATA%\miru\` (Windows). Override directory with `MIRU_CREDENTIALS_DIR`.

**MCP in an IDE:** Put `TAKARA_API_KEY` in the MCP server `env` block. MCP does not reliably inherit your shell or `.env.local` — set it explicitly.

**This repo:** `bun install` then add `TAKARA_API_KEY` to `.env.local` (Bun loads it when you run from the project root).

## IDE integration

### Recommended: `miru install`

Interactive setup (like Semble’s `semble install`). Detects installed agents and configures any combination of:

| Integration | What it does |
|-------------|----------------|
| **MCP server** | Adds `miru` to your agent’s MCP config (`search`, `find_related`) |
| **Instructions** | Appends a marked block to `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, etc. |
| **Sub-agent** | Installs `miru-code` under your **user** config (global, all projects) |

```bash
bun add -g @takara-ai/miru-code
miru setup          # store API key (or set TAKARA_API_KEY for ${TAKARA_API_KEY} in MCP)
miru install
```

Undo with `miru uninstall`. Restart your IDE/agent session after install.

**Supported agents:** Claude Code, Cursor, Gemini CLI, Kiro, OpenCode, GitHub Copilot, Codex, VS Code.

### Global paths (after `miru install`)

| Agent | MCP config | Sub-agent |
|-------|------------|-----------|
| Claude Code | `~/.claude.json` | `~/.claude/agents/miru-code.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/agents/miru-code.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/agents/miru-code.md` |
| Kiro | `~/.kiro/settings/mcp.json` | `~/.kiro/agents/miru-code.md` |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `~/.config/opencode/agents/miru-code.md` |
| GitHub Copilot | `~/.copilot/mcp-config.json` | `~/.copilot/agents/miru-code.agent.md` |
| Codex | `~/.codex/config.toml` | (MCP only) |
| VS Code | user profile `mcp.json` | (MCP only) |

MCP entries use `"env": { "TAKARA_API_KEY": "${TAKARA_API_KEY}" }` where the IDE supports expansion. Export the variable or edit the config with your token.

### Per-project sub-agent (`miru init`)

To commit a sub-agent into a repo (team-shared) instead of global user config:

```bash
miru init --agent claude --force   # → .claude/agents/miru-code.md in cwd
```

Agents: `cursor`, `claude`, `copilot`, `gemini`, `kiro`, `opencode`.

### MCP server

No subcommand starts stdio MCP:

```bash
bunx @takara-ai/miru-code
# or: miru
```

Optional startup flags: `--ref BRANCH` (default git ref for remote repos), `--content code docs …` (same types as CLI).

**Tools**

| Tool | Purpose |
|------|---------|
| `search` | Natural-language or code query; requires `repo`; optional `top_k` (default 5) |
| `find_related` | Similar chunks to `file_path` + `line` (from a search hit); requires `repo`; optional `top_k` |

Indexing runs on the first tool call for each `repo`. Later calls in the same MCP session reuse memory and refresh local files via watch (see [Caching](#caching-what-fresh-means)).

Use `bunx` in MCP config (`command`: `bunx`, `args`: `["@takara-ai/miru-code"]`). After `bun add -g`, you may use `"command": "miru"` instead.

#### Shared env block

Use in every MCP config (some IDEs use `environment` instead of `env`):

```json
{
  "TAKARA_API_KEY": "your-takara-bearer-token",
  "MIRU_OPENAI_BASE_URL": "https://infer.dev.takara.ai/v1",
  "MIRU_OPENAI_EMBEDDING_MODEL": "ds1-potion-code-16m",
  "MIRU_EMBEDDING_DIMENSIONS": "256"
}
```

### Cursor

`~/.cursor/mcp.json` or project `.cursor/mcp.json`:

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

Sub-agent: `miru install` (global) or `miru init --agent cursor` (project-local).

### Claude Code

Project `.mcp.json` or `~/.claude.json`:

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

`${VAR}` expansion is supported. Restart and run `/mcp`, or: `claude mcp add miru -s project -- bunx @takara-ai/miru-code`.

Sub-agent: `miru install` (global) or `miru init --agent claude` (project-local).

### VS Code / GitHub Copilot

`.vscode/mcp.json` or user profile (**MCP: Open User Configuration**). Note `"servers"` not `mcpServers`:

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

Use **MCP: List Servers** to restart after edits. Sub-agent: `miru install`.

### Gemini CLI

`~/.gemini/settings.json` — same `mcpServers` shape as Cursor. `gemini mcp add` or `/mcp` to verify. Prefer `miru install`.

### Kiro

`~/.kiro/settings/mcp.json` — include `PATH` if Bun is not on the default path:

```json
"env": {
  "TAKARA_API_KEY": "your-takara-bearer-token",
  "PATH": "/usr/local/bin:/usr/bin:/bin"
}
```

Sub-agent: `miru install`.

### OpenCode

`opencode.json` uses `mcp`, `"type": "local"`, and `environment`:

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

Verify with `opencode mcp list`. Sub-agent: `miru install`.

## CLI

Installed globally or via `bunx`:

```bash
miru setup
miru install        # interactive MCP + instructions + sub-agent (recommended)
miru search "where are embeddings created" ./src -k 10 --content code
miru find-related src/embeddings/openai.ts 120 ./src
miru uninstall      # remove miru config from agents
miru clear ./src
miru help search    # per-command help
miru -h             # environment variables
```

From **this repo** (development), prefix with `bun run miru` instead of `miru`.

| Command | Summary |
|---------|---------|
| `search <query> [path]` | Hybrid search; `path` defaults to cwd; accepts local path or `https://` git URL |
| `find-related <file> <line> [path]` | Semantic neighbors of the chunk containing that line |
| `setup` | Store and validate `TAKARA_API_KEY` locally |
| `install` | Interactive global agent setup (MCP, instructions, sub-agent) |
| `uninstall` | Remove miru configuration from agents |
| `init --agent <id>` | Write project-local sub-agent markdown |
| `clear [path]` | Delete disk cache for that source |
| *(no command)* | Start MCP server |

**Options:** `-k` / `--top-k N` (default 5), `--content code|docs|config|all` (default `code`). Multiple types: `--content code docs`.

Output is JSON (`query` + `results` with `chunk`, `score`, `location`).

## Library

```ts
import { MiruIndex } from "@takara-ai/miru-code";

// Local directory
const index = await MiruIndex.fromPath("./src", ["code"]);

// Local path or https:// git URL
const fromUrl = await MiruIndex.fromSource("https://github.com/org/repo", ["code"], undefined, "main");

const results = await index.search({
  query: "BM25 tokenize",
  topK: 10, // default 10 in the library API
  filterPaths: ["src/index/bm25.ts"],
  rerank: true,
});

const related = await index.findRelated(results[0], 5);
await index.saveToDefaultCache("./src");
```

Exports: `MiruIndex`, `clearCache`, `findIndexCachePath`, `resolveCacheFolder`, and chunk/result types.

## Environment variables

| Variable | Default / notes |
|----------|-----------------|
| `TAKARA_API_KEY` | **Required** — Takara bearer token |
| `MIRU_OPENAI_BASE_URL` | `https://infer.dev.takara.ai/v1` |
| `MIRU_OPENAI_EMBEDDING_MODEL` | `ds1-potion-code-16m` |
| `MIRU_EMBEDDING_DIMENSIONS` | `256` for potion (auto when unset) |
| `MIRU_FLOAT_VECTORS` | unset = **int8** vectors; `1` = float32 |
| `MIRU_EMBEDDING_BATCH_SIZE` | `32` |
| `MIRU_CONCURRENCY` | logical CPUs **minus 2** (min 1); file IO, embedding batches, BM25 workers |
| `MIRU_MCP_WATCH` | on; set `0` or `false` to disable MCP filesystem watch |
| `MIRU_CREDENTIALS_DIR` | override stored-credentials directory |
| `MIRU_PIPELINE_EMBED_BATCH` | optional pipeline tuning (see `.env.example`) |
| `MIRU_PIPELINE_EMBED_INFLIGHT` | optional pipeline tuning |

Parallelism covers chunking, concurrent embedding requests, overlapping query embed with BM25, and BM25 worker sharding on large indexes.

## Developing Miru

```bash
bun install
cp .env.example .env.local   # add TAKARA_API_KEY
bun test
bun run typecheck
```

**Local MCP** — point at your `miru-code` clone:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/miru-code/src/cli.ts"],
  "env": {
    "TAKARA_API_KEY": "your-takara-bearer-token"
  }
}
```

Merge into the IDE’s wrapper (`mcpServers`, `servers`, or `mcp`).

## Publishing

Releases use **Bun** for install, test, and `bun pm pack`. Registry upload uses **`npm publish`** on that tarball because [Bun does not yet support npm OIDC trusted publishing](https://github.com/oven-sh/bun/issues/22423).

**Local** (logged in to npm):

```bash
bun publish
```

Runs `prepublishOnly` (typecheck + tests). Do not add a `publish` script that calls `npm publish` — that would upload twice.

**CI** (Trusted Publisher on npm):

```bash
npm version patch
git push && git push --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
```

`release.yml` publishes when the GitHub Release is published.

## License

MIT
