# Miru (見る)

Hybrid code search for AI agents — **Bun**, **TypeScript**, **Takara embeddings**.

Find code by meaning, not grep. Miru returns the best **chunks** (path, lines, snippet) for questions like “where is auth middleware configured?”

**Requires:** [Bun](https://bun.sh) 1.1+ · [Takara API key](https://takara.ai)

## Privacy and API usage

Miru sends **file contents** to the [Takara inference API](https://takara.ai) when building an index and when embedding search queries. Chunks from your repo are transmitted over HTTPS to generate embeddings. API usage may incur cost depending on your Takara plan.

If you index proprietary code, make sure that sending snippets to Takara's endpoint fits your security and compliance requirements. Use `MIRU_WORKSPACE_ROOT` to restrict MCP indexing to a single workspace directory.

## Install

```bash
bun add -g @takara-ai/miru-code
```

## Set up API key

```bash
miru setup
```

Validates your key and saves it locally. Skip this if you prefer — `miru search` or `miru install` will prompt on first run.

```bash
miru setup --key YOUR_TOKEN   # non-interactive
miru setup --clear            # remove stored key
```

MCP loads your key from `credentials.json` automatically — no env block needed in MCP config.

## Add to your IDE

```bash
miru install
```

Interactive TUI — **↑↓** move, **space** toggle, **a** all, **enter** confirm. Pick agents and integrations:

| Integration | What it does |
|-------------|----------------|
| MCP server | `search`, `expand`, and `find_related` tools in the agent |
| Instructions | Search policy in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` |
| Sub-agent | Dedicated `miru-code` agent file |
| Cursor rules | Always-on `.cursor/rules/miru-code.mdc` (Cursor only) |
| Search hooks | Block built-in Grep/Glob and redirect to Miru MCP |

Restart the IDE when done.

```bash
miru uninstall   # remove miru config
```

**Supported:** Cursor · Claude Code · Gemini CLI · Kiro · OpenCode · GitHub Copilot · Codex · VS Code · Visual Studio (Windows) · Windsurf / Devin Desktop

| IDE | MCP | Instructions / rules | Hooks |
|-----|-----|------------------------|-------|
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/rules/miru-code.mdc` | `~/.cursor/hooks.json` |
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` | `~/.gemini/settings.json` (`BeforeTool`) |
| Kiro | `~/.kiro/settings/mcp.json` | `~/.kiro/steering/miru.md` | `~/.kiro/settings/hooks.json` |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/plugins/miru-search-guard.ts` |
| GitHub Copilot | `~/.copilot/mcp-config.json` | — | `~/.copilot/hooks/miru-search.json` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/hooks.json` |
| VS Code | `…/Code/User/mcp.json` | — | `~/.copilot/hooks/miru-search.json` |
| Visual Studio | `%USERPROFILE%\.mcp.json` | — | `~/.copilot/hooks/miru-search.json` |
| Windsurf | — | — | `~/.codeium/windsurf/hooks.json` |

Sub-agent files are also written where supported (see `miru install` plan). Windsurf hooks only — no MCP entry yet.

### Search hooks

Hooks run `miru hook-guard` before built-in search tools execute. They **block** conceptual Grep/Glob/SemanticSearch and shell `rg`/`grep`/`find`, and tell the agent to use Miru MCP `search` instead. Exact literal lookups (e.g. `REDIS_HOST`, a symbol name) still pass through.

Hooks are optional at install time but **on by default**. Disable them in the installer if you only want MCP + instructions.

**Team sub-agent in a repo** (optional):

```bash
miru init --agent claude --force
```

## Try it

```bash
miru search "auth middleware" ./src
miru expand src/auth.ts 42 ./src
miru find-related src/auth.ts 42 ./src
```

Terminal output is human-readable; use `--json` for scripts. One-off without installing:

```bash
bunx @takara-ai/miru-code search "auth middleware" ./src
```

---

## MCP tools

When wired via `miru install`, the MCP server exposes three tools. Pass the **project root** as `repo` for local workspaces (or an `https://` git URL). The index is built on the first call and cached for the session.

| Tool | When to use |
|------|-------------|
| `search` | Default for code exploration — hybrid semantic + keyword search. One call per question. |
| `expand` | More context in the **same file** when a hit has `truncated: true`. |
| `find_related` | Similar code in **other files** from a `file_path` + line anchor. |

### Workflow

1. **`search`** with `query` + `repo` — returns compact snippets (~±15 lines) and relevance scores.
2. If a hit has **`truncated: true`**, call **`expand`** with `file_path`, `line` (`anchor_line` or `start_line`), and `repo` — not another search or a full-file read.
3. To trace similar patterns elsewhere, call **`find_related`** with the same `file_path`, `line`, and `repo`.
4. Use your editor's **Read** on `absolute_path` only when editing or when `expand` still lacks context.

Prefer these tools over Grep, Glob, or SemanticSearch when Miru MCP is connected — hooks and instructions enforce that when enabled.

### Parameters

**`search`**

| Param | Required | Notes |
|-------|----------|-------|
| `query` | yes | Natural language or code query |
| `repo` | yes | Project root or git URL |
| `top_k` | no | Results to return (default 3, max 10) |
| `dedupe_by_file` | no | Keep best hit per file (default `true`) |

**`expand`**

| Param | Required | Notes |
|-------|----------|-------|
| `file_path` | yes | From hit `file_path` or `absolute_path` (local repos) |
| `line` | yes | `anchor_line` when truncated, else `start_line` (1-indexed) |
| `repo` | yes | Same repo as the search |
| `before` / `after` | no | Extra chunks before/after anchor (default 1 each) |

**`find_related`**

| Param | Required | Notes |
|-------|----------|-------|
| `file_path` | yes | From a search hit |
| `line` | yes | `anchor_line` or `start_line` |
| `repo` | yes | Same repo as the search |
| `top_k` | no | Related chunks to return (default 3, max 10) |

Local repo hits include `absolute_path` for one-click navigation. Confirm exact literals (env var names, quoted strings) with native grep when needed.

## How it works

Hybrid search: Takara embeddings + BM25 + fusion + reranking. Indexes **code**, **docs**, **config**, or **all** via `--content`.

Disk cache: `~/Library/Caches/miru` (macOS), `~/.cache/miru` (Linux). MCP watches local files and updates incrementally; run `miru clear .` after big refactors when using CLI only. Upgrading Miru invalidates stale indexes automatically when the package version epoch changes.

### Chunking & languages

Miru chunks source in tiers: **AST** (tree-sitter, default) → **structural** heuristics → **line** splits.

**AST chunking** — 22 languages (syntax-aware boundaries via vendored `web-tree-sitter` grammars):

| Language | Typical extensions |
|----------|-------------------|
| bash | `.sh`, `.bash`, `.zsh` |
| c | `.c` |
| cpp | `.cpp`, `.h`, `.hpp`, etc. |
| csharp | `.cs` |
| css | `.css` |
| dart | `.dart` |
| elixir | `.ex`, `.exs` |
| embeddedtemplate | ERB-style templates |
| go | `.go` |
| haskell | `.hs` |
| html | `.html` |
| java | `.java` |
| javascript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| json | `.json` |
| ocaml | `.ml`, etc. |
| php | `.php` |
| python | `.py`, `.pyi` |
| ruby | `.rb` |
| rust | `.rs` |
| scala | `.scala` |
| solidity | `.sol` |
| typescript | `.ts`, `.mts`, `.cts` |

**Also shipped:** `.tsx` uses a dedicated TSX grammar; extra OCaml and PHP-only grammars are vendored alongside the main set.

**Structural fallback** (brace/indent heuristics when AST is unavailable): python, go, typescript, javascript, cpp, c.

**Line fallback:** everything else that gets indexed (kotlin, swift, vue, sql, etc.) — still searchable, coarser chunks.

Set `MIRU_AST_CHUNKING=0` to disable AST and use structural → lines only.

## CLI reference

| Command | Purpose |
|---------|---------|
| `miru setup` | Store API key |
| `miru install` | Configure IDE (global) |
| `miru uninstall` | Remove IDE config |
| `miru search <query> [path]` | Search (`-k N`, `--content`, `--json`) |
| `miru find-related <file> <line> [path]` | Related chunks |
| `miru init --agent <id>` | Project-local sub-agent |
| `miru clear [path]` | Drop index cache |
| `miru hook-guard` | PreToolUse hook entrypoint (used by installers; reads JSON stdin) |
| `miru` | Start MCP server |

## Library

```bash
bun add @takara-ai/miru-code
```

```ts
import { MiruIndex } from "@takara-ai/miru-code";

const index = await MiruIndex.fromPath("./src");
const results = await index.search({ query: "BM25 tokenize", topK: 10 });
```

## Environment

| Variable | Notes |
|----------|-------|
| `TAKARA_API_KEY` | Required |
| `MIRU_OPENAI_BASE_URL` | Default `https://infer.takara.ai/v1` |
| `MIRU_OPENAI_EMBEDDING_MODEL` | Default `ds1-miru-int8` |
| `MIRU_WORKSPACE_ROOT` | Restrict MCP local `repo` paths to this directory |
| `MIRU_MAX_INDEX_FILES` | Cap files indexed per operation |
| `MIRU_ALLOW_HTTP_GIT` | Set `1` to allow plain `http://` git clones |
| `MIRU_MCP_WATCH` | Set `0` to disable MCP file watch |
| `MIRU_AST_CHUNKING` | Set `0` to disable tree-sitter AST chunking |
| `MIRU_QUIET` | Set `1` to skip the framed CLI banner (subtitle only on color terminals) |
| `NO_COLOR` | Disable CLI colors |

See `.env.example` for more.

## Manual MCP (skip `miru install`)

```json
{
  "miru": {
    "command": "miru",
    "args": []
  }
}
```

Run `miru setup` once so the server can load your key from `credentials.json`.

Use `bunx` + `@takara-ai/miru-code` if `miru` is not global. Wrapper key varies by IDE (`mcpServers`, `servers`, or `mcp`).

## Developing

```bash
git clone https://github.com/takara-ai/miru-code.git && cd miru-code
bun install && cp .env.example .env.local
bun test && bun run typecheck
```

Local MCP: `"command": "bun", "args": ["/path/to/miru-code/src/cli.ts"]`

### CLI banner

`miru help` and setup print a framed wordmark and Takara crane on color terminals. Set `MIRU_QUIET=1` to use the subtitle line only.

Crane ASCII art is committed in `src/brand-banner.ts`. To regenerate it from the SVG source (local `assets/red_crane_vector.svg`, gitignored):

```bash
bun run scripts/render-crane-art.ts
```

Copy the printed `TAKARA_CRANE` constant into `src/brand-banner.ts`. Requires ImageMagick (`magick`).

## License

MIT
