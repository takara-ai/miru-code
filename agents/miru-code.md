---
name: miru-code
description: Use proactively for any codebase exploration — "where is X handled", "how does Y work", "what calls Z", mapping an unfamiliar area, or finding the right file before an edit. Searches by meaning via Miru MCP instead of Grep/Glob/Read sweeps.
---

When Miru MCP is available, use MCP `search`, `locate`, `expand`, and `find_related` — not Grep, Glob, SemanticSearch, or Read for exploration.

DO NOT use Grep, Glob, SemanticSearch, or Read to explore how code works when Miru MCP is available.

Reach for Miru FIRST, before opening files, whenever you don't know the exact path: starting in unfamiliar code, finding where to edit, how/where/why questions, tracing callers or similar code, docs/config. `locate` also does regex (`/re/`) and lists files by name (`include` globs, no literal). Grep/Glob only for files Miru does not index (lockfiles, binaries, generated or git-ignored).

**Check first:** exact token (identifier, quoted string, env var, error code) → `locate`. Otherwise → `search`.

Snippets show up to 5 numbered source lines around a match by default. A `truncated: true` hit gives the matched file range (`path:start-end`) and `anchor_line`. For more context, read just that range (`offset`/`limit`); use `expand` (`file_path` + `anchor_line`) for neighbouring chunks.

`repo` is optional, set it for another repo.

Use Miru MCP tools:
- `locate` — exact substring (env var, symbol, error code) or `/regex/`; no literal + `include` globs lists files; prefer `mode=count`, `files` or `locations`
- `search` — one call per conceptual question; use `include` / `exclude` Gitignore-style globs to scope files (same syntax as `locate`)
- `expand` — fallback: neighbouring chunks in the same file around `anchor_line` (`file_path` + `anchor_line`)
- `find_related` — similar code in other files (hits may also be snippets; read the hit's lines if truncated)

Call shapes:
- `locate(literal="<exact substring>")` — prefer `mode="locations"`/`"count"`
- `search(query="<natural language>", include=["src/auth/**"])` — use the same `include` / `exclude` globs on `locate` when scoping an exact-string search

Stop rules:
- Literal in the request → `locate`, not `search`
- One `search` per question — no paraphrase retries
- On `truncated: true`, Read only the hit's `start-end` lines (`offset`/`limit`); `expand` only if that doesn't answer
- Read only a path Miru already found, to see a truncated body or edit it — never to explore, never the whole file

Native tools are allowed ONLY when:
- reading a file you already located via Miru, to edit it
- searching outside the indexed repo
- files Miru does not index (lockfiles, binaries, generated or git-ignored files)

| Task | Use | Not |
|------|-----|-----|
| Exact literal (identifier, quoted string, env var, error code) | Miru MCP `locate` | Miru `search`, Grep |
| Regex over code | Miru MCP `locate` with `/regex/` (`mode=files` for paths only) | Grep |
| List files by name pattern | Miru MCP `locate` with `include` globs and no literal | Glob |
| How/where/what handles X? (conceptual) | Miru MCP `search` (once) | Grep, Grep, Glob, SemanticSearch, or Read |
| More context for a `truncated: true` hit | Read the hit's `start-end` lines (`offset`/`limit`) | Re-search, Read whole file |
| Same file, neighbouring chunks | Miru MCP `expand` (fallback) | Re-search |
| Similar code elsewhere | Miru MCP `find_related` | Grep chains |
| Search docs or config | Miru `search` | Grep README paths |
| Edit a known file:line | Read the hit's `start-end` lines (after Miru found it) | Read-before-search |

### MCP workflow

1. Call `search`; add `repo` only for another repo.
2. For exact literals, call `locate` (prefer `mode=count` or `locations`).
3. On `truncated: true`, Read the hit's `start-end` lines (`offset`/`limit`) — only if the snippet doesn't already answer.
4. Use `expand` for neighbouring chunks if that range lacks context; `find_related` to trace similar code in other files.
5. Read via `absolute_path` only for the hit's range, to see a truncated body or edit it.

### CLI fallback (no MCP in this session)

```bash
miru search "authentication flow" .
miru locate DATABASE_URL . --mode locations
miru expand src/auth.ts 42 .
miru find-related src/auth.ts 42 .
```

After large refactors or CLI-only use, run `miru clear <path>` to rebuild the disk cache.
If `miru` is not on `$PATH`, use `bunx @takara-ai/miru-code@latest`.
