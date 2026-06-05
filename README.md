# Miru (見る)

Hybrid code search for AI agents — **TypeScript**, **Bun**, and **Takara embeddings**.

Miru helps coding agents **find code by meaning**. Ask “where is auth middleware configured?” and get back the most relevant **chunks** (file path, line range, snippet) instead of grepping the whole tree.

## Quick start

**Requirements:** [Bun](https://bun.sh) 1.1+ and a [Takara API key](https://takara.ai) for embeddings.

```bash
# 1. Install the CLI
bun add -g @takara-ai/miru-code

# 2. Store your API key (validates against Takara)
miru setup

# 3. Wire into your agents (MCP + instructions + sub-agent)
miru install

# 4. Restart your IDE / agent session, then search
miru search "auth middleware" ./src
```

That’s the full path for most users. `miru install` is interactive — it detects Cursor, Claude Code, Gemini CLI, Kiro, OpenCode, GitHub Copilot, Codex, and VS Code, and lets you pick what to configure.

**One-off without installing:**

```bash
bunx @takara-ai/miru-code search "auth middleware" ./src
```

**Undo agent setup:** `miru uninstall`

---

## How to read this doc

| Goal | Section |
|------|---------|
| Get running in an IDE | [Quick start](#quick-start) → [IDE integration](#ide-integration) |
| Search from terminal or scripts | [CLI](#cli) |
| Use as a library | [Library](#library) |
| Contribute to this repo | [Developing Miru](#developing-miru) |

## Install options

| Method | Command | When to use |
|--------|---------|-------------|
| Global CLI | `bun add -g @takara-ai/miru-code` | Daily use, `miru install`, terminal search |
| One-off | `bunx @takara-ai/miru-code …` | Try before installing |
| Library | `bun add @takara-ai/miru-code` | Embed search in your own tool |
| From source | [Developing Miru](#developing-miru) | Contributors |

After install, `miru` is on your PATH. Run `miru` with no args for help.

## Credentials

Miru needs `TAKARA_API_KEY` — a Takara bearer token for code embeddings.

```bash
miru setup              # interactive; validates and stores locally
miru setup --key TOKEN  # non-interactive
miru setup --clear      # remove stored key
```

Stored credentials live at:

- macOS: `~/Library/Application Support/miru/credentials.json`
- Linux: `~/.config/miru/credentials.json`
- Windows: `%APPDATA%\miru\credentials.json`

Override with `MIRU_CREDENTIALS_DIR`.

**For MCP in an IDE:** also set `TAKARA_API_KEY` in the MCP server `env` block. MCP subprocesses do not reliably inherit your shell or `.env.local`. `miru install` writes `"TAKARA_API_KEY": "${TAKARA_API_KEY}"` where your IDE supports variable expansion — export the var or paste your token.

## IDE integration

### Recommended: `miru install`

Configures up to three integrations per agent:

| Integration | What it does |
|-------------|----------------|
| **MCP server** | Native `search` and `find_related` tools |
| **Instructions** | Marked usage block in `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, etc. |
| **Sub-agent** | Global `miru-code` agent file (Bash-backed search for sub-agents without MCP) |

```bash
miru install      # pick agents + integrations
miru uninstall    # remove miru entries
```

Restart your IDE or agent session after install.

### Where files go (global user config)

| Agent | MCP config | Sub-agent |
|-------|------------|-----------|
| Claude Code | `~/.claude.json` | `~/.claude/agents/miru-code.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/agents/miru-code.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/agents/miru-code.md` |
| Kiro | `~/.kiro/settings/mcp.json` | `~/.kiro/agents/miru-code.md` |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `~/.config/opencode/agents/miru-code.md` |
| GitHub Copilot | `~/.copilot/mcp-config.json` | `~/.copilot/agents/miru-code.agent.md` |
| Codex | `~/.codex/config.toml` | — |
| VS Code | user profile `Code/User/mcp.json` | — |

### Per-project sub-agent (`miru init`)

To commit a sub-agent into a repo for your team (project-local, not global):

```bash
miru init --agent claude --force   # → .claude/agents/miru-code.md
```

Agents: `cursor`, `claude`, `copilot`, `gemini`, `kiro`, `opencode`.

### Manual MCP setup

Skip `miru install` and add this to your IDE’s MCP config (`mcpServers`, `servers`, or `mcp` depending on the tool):

```json
{
  "miru": {
    "command": "bunx",
    "args": ["@takara-ai/miru-code"],
    "env": {
      "TAKARA_API_KEY": "your-takara-bearer-token"
    }
  }
}
```

After `bun add -g @takara-ai/miru-code`, you can use `"command": "miru"` instead of `bunx`.

**MCP tools**

| Tool | Purpose |
|------|---------|
| `search` | Natural-language or code query; requires `repo` (project root or `https://` git URL); optional `top_k` (default 5) |
| `find_related` | Similar chunks to `file_path` + `line` from a prior hit; requires `repo` |

Indexing runs on the first tool call per `repo`. Pass the **project root** for local workspaces. Remote repos need an explicit `https://` or `http://` URL (not `git@` SSH).

**IDE-specific notes**

- **Claude Code:** supports `${TAKARA_API_KEY}` in config; verify with `/mcp`. Or: `claude mcp add miru -s user -- bunx @takara-ai/miru-code`
- **VS Code:** uses `"servers"` not `mcpServers`; restart via **MCP: List Servers**
- **OpenCode:** uses `mcp`, `"type": "local"`, and `environment` instead of `env`
- **Kiro:** include `PATH` in `env` if Bun is not on the default path

Optional MCP startup flags: `--ref BRANCH`, `--content code docs …`

## How Miru works

### Hybrid search

1. **Dense (semantic)** — Takara code embeddings (`ds1-potion-code-16m`) over structurally chunked files
2. **Sparse (BM25)** — keyword index; parallelized in Bun workers when the index has 256+ chunks
3. **RRF fusion** — merges semantic and keyword rankings
4. **Reranking** — code-tuned boosts and penalties

Index **code**, **docs**, **config**, or **all** via `--content` (CLI/MCP) or when building a library index.

### Agent workflow

1. `search` with a natural-language or code query
2. Read returned chunks
3. `find_related` on a promising `file_path` + line (optional)
4. Open full files only when the chunk is not enough
5. Use grep for exhaustive literal matches

### Caching

| Layer | Behavior |
|-------|----------|
| **First search** | Builds index, writes disk cache |
| **MCP (local repo, same session)** | Watches files and incrementally re-indexes; disable with `MIRU_MCP_WATCH=0` |
| **CLI / new MCP session** | Reuses disk cache; run `miru clear <path>` after large refactors |
| **Remote repos** | Cloned per session; use `--ref` for branch/tag |

Cache: `~/Library/Caches/miru` (macOS), `~/.cache/miru` (Linux), `%LOCALAPPDATA%\miru\Cache` (Windows).

## CLI

```bash
miru setup
miru install
miru search "where are embeddings created" ./src -k 10 --content code
miru find-related src/embeddings/openai.ts 120 ./src
miru clear ./src
miru uninstall
miru help search
```

| Command | Summary |
|---------|---------|
| `search <query> [path]` | Hybrid search; path defaults to cwd; local path or `https://` git URL |
| `find-related <file> <line> [path]` | Semantic neighbors at that line |
| `setup` | Store and validate `TAKARA_API_KEY` |
| `install` | Interactive global agent setup |
| `uninstall` | Remove miru agent configuration |
| `init --agent <id>` | Project-local sub-agent markdown |
| `clear [path]` | Delete disk cache |
| *(no command)* | Start stdio MCP server |

**Options:** `-k` / `--top-k N` (default 5), `--content code|docs|config|all`, `--json` (force JSON output).

**Output:** In a terminal, search results are formatted for reading (path, score, snippet preview). Piped output and `--json` emit JSON (`query` + `results` with `chunk`, `score`, `location`). Progress spinners go to stderr.

From **this repo**, prefix commands with `bun run miru`.

## Library

```ts
import { MiruIndex } from "@takara-ai/miru-code";

const index = await MiruIndex.fromPath("./src", ["code"]);
const fromUrl = await MiruIndex.fromSource(
  "https://github.com/org/repo",
  ["code"],
  undefined,
  "main",
);

const results = await index.search({
  query: "BM25 tokenize",
  topK: 10,
  filterPaths: ["src/index/bm25.ts"],
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
| `MIRU_FLOAT_VECTORS` | unset = int8; `1` = float32 |
| `MIRU_EMBEDDING_BATCH_SIZE` | `32` |
| `MIRU_CONCURRENCY` | logical CPUs minus 2 (min 1) |
| `MIRU_MCP_WATCH` | on; `0` or `false` disables MCP file watch |
| `MIRU_CREDENTIALS_DIR` | Override credentials directory |
| `NO_COLOR` | Disable CLI colors |

See `.env.example` for optional pipeline tuning (`MIRU_PIPELINE_*`).

## Developing Miru

```bash
git clone https://github.com/takara-ai/miru-code.git
cd miru-code
bun install
cp .env.example .env.local   # add TAKARA_API_KEY
bun test
bun run typecheck
bun run lint
```

**Local MCP** — point at your clone:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/miru-code/src/cli.ts"],
  "env": {
    "TAKARA_API_KEY": "your-takara-bearer-token"
  }
}
```

## Publishing

Releases use **Bun** for install, test, and `bun pm pack`. Registry upload uses **`npm publish`** on that tarball because [Bun does not yet support npm OIDC trusted publishing](https://github.com/oven-sh/bun/issues/22423).

```bash
bun publish   # local, logged in to npm
```

**CI:** tag a GitHub Release; `release.yml` publishes to npm via Trusted Publisher.

## License

MIT
