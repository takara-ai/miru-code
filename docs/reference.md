# Reference

[Quick start](../README.md) · [Agent integrations](integrations.md)

## CLI reference

Run `miru` in a terminal or `miru -h` for the command list, or `miru <command> -h` for details.

| Command                                  | Purpose                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `miru setup`                             | Authenticate and store credentials                                                |
| `miru install`                           | Configure IDE (global)                                                            |
| `miru uninstall`                         | Remove IDE config                                                                     |
| `miru search <query> [path]`             | Search (`--content`, `--json`)                                            |
| `miru locate <literal> [path]`           | Exact substring in the index                                                      |
| `miru expand <file> <line> [path]`       | Adjacent chunks in the same file                                                  |
| `miru find-related <file> <line> [path]` | Related chunks                                                                    |
| `miru benchmark on/off/status/clear`     | Toggle MCP benchmark mode / clear report                                          |
| `miru init --agent <id>`                 | Project-local sub-agent                                                           |
| `miru clear [path]`                      | Drop index cache (use after big CLI-only refactors)                               |
| `miru mcp`                               | Start MCP server (`--benchmark` for comparisons)                                  |

CLI uses hyphens (`find-related`); MCP tool names use underscores (`find_related`).

## Credentials

```bash
miru setup                   # device-code sign-in
miru setup --device          # explicit device-code sign-in
miru setup --key YOUR_TOKEN  # store a bearer token
miru setup --clear           # remove stored credentials
```

Credentials are saved in `credentials.json` and loaded or refreshed automatically. `TAKARA_API_KEY` overrides stored credentials. Plugin installations use their own credentials directories.

For self-hosted embeddings, see [SageMaker setup](self-hosted-sagemaker.md).

## MCP workflow

1. Use `search` for meaning-based questions and `locate` for exact strings, regex matches, or filenames.
2. For a `truncated: true` result, read the reported file range. Use `expand` if you need neighbouring chunks.
3. Use `find_related` for similar code in other files.

The optional `repo` argument accepts a local path or Git URL and defaults to the server's working directory. Keep it on follow-up calls. Results include `absolute_path` for local files. `MIRU_SNIPPET_LINES` controls excerpt context (default two lines on each side; `0` shows only the matching line).

## MCP parameters

### `search`

| Param            | Required | Notes                                   |
| ---------------- | -------- | --------------------------------------- |
| `query`          | yes      | Natural language or code query          |
| `repo`           | no       | Startup directory by default; set for another repo |
| `include`        | no       | Gitignore-style glob patterns; only matching files are searched (same as `locate.include`) |
| `exclude`        | no       | Gitignore-style glob patterns; matching files are skipped (same as `locate.exclude`) |
| `dedupe_by_file` | no       | Keep best hit per file (default `true`) |

### `locate`

| Param         | Required | Notes                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| `literal`     | no       | Exact substring, array of strings, or `/regex/`; omit with `include` to list files                                                             |
| `repo`        | no       | Startup directory by default; set for another repo                                |
| `include`     | no       | Gitignore-style glob patterns; only matching files are searched                    |
| `exclude`     | no       | Gitignore-style glob patterns; matching files are skipped                          |
| `mode`        | no       | `count` · `files` (unique paths) · `locations` · `lines` (default). Prefer `count`/`files`/`locations` when possible |
| `limit`       | no       | Cap returned hits. Omit to return all matches                                       |
| `ignore_case` | no       | Case-insensitive match (default `false`) |
| `match_variants` | no | Match camelCase, snake_case, and other casings |
| `context_lines` | no | Context lines around matches in `lines` mode |
| `query` | no | Alias for `literal` |

### `expand`

| Param              | Required | Notes                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `file_path`        | yes      | From hit `file_path` or `absolute_path` (local repos)                 |
| `anchor_line`      | yes      | From the search hit (`anchor_line` when truncated, else `start_line`) |
| `repo`             | no       | Same repo as the search, if set                                        |
| `before` / `after` | no       | Extra chunks before/after anchor (default 1 each)                     |

### `find_related`

| Param         | Required | Notes                                        |
| ------------- | -------- | -------------------------------------------- |
| `file_path`   | yes      | From a search hit                            |
| `anchor_line` | yes      | From the search hit                          |
| `repo`        | no       | Same repo as the search, if set              |

### `read_benchmark` *(benchmark mode only)*

| Param  | Required | Notes                                                                  |
| ------ | -------- | ---------------------------------------------------------------------- |
| `repo` | no       | Filter rollup to one local path or git URL. Omit for all saved queries |

### `auth`

| Param | Required | Notes |
| --- | --- | --- |
| `action` | no | `start` (default), `check`, or `sagemaker` |
| `endpoint_arn` | For SageMaker | Endpoint ARN to validate and save |
| `aws_profile` | For SageMaker | Existing AWS profile |

Start device sign-in after a tool reports missing or invalid credentials. SageMaker configuration requires an explicit user request.

## How it works

Miru combines Takara embeddings and BM25 with linear fusion and code-aware ranking. Index **code**, **docs**, **config**, or **all** with `--content`. Set `MIRU_RANK_FUSION=rrf` for reciprocal rank fusion.

MCP watches local files and updates the index incrementally. Package upgrades invalidate stale caches via the version epoch.

| OS | Index cache |
|----|-------------|
| macOS | `~/Library/Caches/miru` |
| Linux | `~/.cache/miru` |
| Windows | `%LOCALAPPDATA%\miru\Cache` |

### Chunking & languages

Miru chunks source in tiers: **AST** (tree-sitter, default) → **structural** heuristics → **line** splits.

**AST chunking** — 26 languages (syntax-aware boundaries via vendored `web-tree-sitter` grammars):

| Language | Typical extensions |
|----------|-------------------|
| astro | `.astro` |
| bash | `.sh`, `.bash`, `.zsh` |
| c | `.c` |
| cpp | `.cpp`, `.h`, `.hpp`, etc. |
| csharp | `.cs` |
| css | `.css` |
| dart | `.dart` |
| elixir | `.ex`, `.exs` |
| embeddedtemplate | `.erb`, `.ejs` |
| go | `.go` |
| haskell | `.hs` |
| html | `.html`, `.htm` |
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
| sql | `.sql` |
| svelte | `.svelte` |
| typescript | `.ts`, `.tsx`, `.mts`, `.cts` |
| vue | `.vue` |

**Structural fallback** (brace/indent heuristics when AST is unavailable): python, go, typescript, javascript, cpp, c.

**Line fallback:** everything else that gets indexed (kotlin, swift, etc.) — still searchable, coarser chunks.

Set `MIRU_AST_CHUNKING=0` to disable AST and use structural → lines only.

## Library

```bash
bun add @takara-ai/miru-code
```

```ts
import { MiruIndex } from "@takara-ai/miru-code";

const index = await MiruIndex.fromPath("./src");
const results = await index.search({ query: "BM25 tokenize" });
```

CLI and MCP code searches using `ds1-miru-int8` return the top four distinct files
by default. A bundled CPU tree reranker refines int8 + BM25 scores and existing
symbol boosts for every query, including symbols, paths and non-English text.
It needs no additional model download or inference API call. See the
[evaluation and serving policy](always-on-ranker.md) for results and tradeoffs.

## Environment

| Variable                      | Notes                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| `TAKARA_API_KEY`              | Optional bearer-token override for stored credentials |
| `MIRU_OPENAI_BASE_URL`        | Default `https://infer.takara.ai/v1`                                     |
| `MIRU_OPENAI_EMBEDDING_MODEL` | Default `ds1-miru-int8`                                                  |
| `MIRU_RESIDUAL_TOP4`         | Set `0` to restore five code-search results while keeping the reranker   |
| `MIRU_RESIDUAL_RANK_MODEL`   | Override the bundled reranker JSON; set `0` to disable learned ranking   |
| `MIRU_WORKSPACE_ROOT`         | Optional: restrict MCP local `repo` paths to this directory              |
| `MIRU_MAX_INDEX_FILES`        | Cap files indexed per operation                                          |
| `MIRU_ALLOW_HTTP_GIT`         | Set `1` to allow plain `http://` git clones                              |
| `MIRU_MCP_WATCH`              | Set `0` to disable MCP file watch                                        |
| `MIRU_AST_CHUNKING`           | Set `0` to disable tree-sitter AST chunking                              |
| `MIRU_BENCHMARK_HISTORY_PATH` | Override; see [Benchmark mode](#benchmark-mode)                          |
| `MIRU_CACHE_HOME`             | Override the platform cache root (see [How it works](#how-it-works))    |
| `MIRU_QUIET`                  | Set `1` to skip the framed CLI banner (subtitle only on color terminals) |
| `NO_COLOR`                    | Disable CLI colors                                                       |

See [`.env.example`](../.env.example) for more.

## Benchmark mode

Compare Miru response tokens with a ripgrep search plus reading the top matched file. This measures a search workflow, not the agent's total token usage. Comparisons require a local repository.

```bash
miru benchmark on
miru benchmark status
miru benchmark off
miru benchmark clear
```

Restart agents after changing mode. For the Claude Code plugin, use its benchmark setting instead of the CLI toggle.

Each `search` or `locate` response includes token counts and savings while benchmark mode is enabled. Use `read_benchmark` for totals.

History is global and stored as plaintext JSONL without query text:

| OS | Default path |
| --- | --- |
| macOS | `~/Library/Application Support/miru/benchmark-history.json` |
| Linux | `~/.config/miru/benchmark-history.json` (`$XDG_CONFIG_HOME/miru/…` when set) |
| Windows | `%APPDATA%\\miru\\benchmark-history.json` |

Override the path with `MIRU_BENCHMARK_HISTORY_PATH`. Use `miru benchmark clear` to delete saved reports.

## Manual MCP

Use this when your client needs a hand-written MCP entry:

```json
{
  "miru": {
    "command": "bunx",
    "args": ["@takara-ai/miru-code@latest", "mcp"]
  }
}
```

The wrapper key depends on your client (`mcpServers`, `servers`, or `mcp`). Sign in through the MCP `auth` tool when prompted, or use `miru setup` for the default CLI credentials directory. Add `--benchmark` after `mcp` to enable comparisons.

A running server keeps its package version until restarted.
