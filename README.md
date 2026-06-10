# Miru (見る)

Hybrid code search for AI agents — **Bun**, **TypeScript**, **Takara embeddings**.

Find code by meaning, not grep. Miru returns the best **chunks** (path, lines, snippet) for questions like “where is auth middleware configured?”

**Requires:** [Bun](https://bun.sh) 1.1+ · [Takara API key](https://takara.ai)

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
| MCP server | `search` and `find_related` tools in the agent |
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
miru find-related src/auth.ts 42 ./src
```

Terminal output is human-readable; use `--json` for scripts. One-off without installing:

```bash
bunx @takara-ai/miru-code search "auth middleware" ./src
```

---

## MCP tools

When wired via `miru install`, your agent gets:

| Tool | What it does |
|------|----------------|
| `search` | Query by meaning; pass `repo` (project root or `https://` git URL) |
| `find_related` | Similar code at a `file_path` + line from a search hit |

Pass the **project root** as `repo` for local projects. Prefer these over Grep, Glob, or SemanticSearch when Miru MCP is connected — hooks and instructions enforce that when enabled.

## How it works

Hybrid search: Takara embeddings + BM25 + fusion + reranking. Indexes **code**, **docs**, **config**, or **all** via `--content`.

Disk cache: `~/Library/Caches/miru` (macOS), `~/.cache/miru` (Linux). MCP watches local files and updates incrementally; run `miru clear .` after big refactors when using CLI only.

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
| `MIRU_MCP_WATCH` | Set `0` to disable MCP file watch |
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

## License

MIT
