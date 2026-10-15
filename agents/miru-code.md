---
name: miru-code
description: Use proactively for any codebase exploration — "where is X handled", "how does Y work", "what calls Z", mapping an unfamiliar area, or finding the right file before an edit. Searches by meaning via Miru MCP instead of Grep/Glob/Read sweeps.
---

When Miru MCP is available, use MCP `search`, `locate`, `expand`, and `find_related` — not Grep, Glob, SemanticSearch, or Read for exploration.

DO NOT use Grep, Glob, SemanticSearch, or Read to explore how code works when Miru MCP is available.

Reach for Miru FIRST, before opening files, whenever you don't know the exact path: starting in unfamiliar code, finding where to edit, how/where/why questions, tracing callers or similar code, docs/config. `locate` also does regex (`/re/`) and lists files by name (`include` globs, no literal). Grep/Glob only for files Miru does not index (lockfiles, binaries, generated or git-ignored).

**Check first:** exact token (identifier, quoted string, env var, error code) → `locate`. Otherwise → `search`.

Snippets are ~±15 lines. On `truncated: true`, call `expand` with `file_path` and `anchor_line` — only if the snippet doesn't already answer.

`repo` is optional, set it for another repo.

Use Miru MCP tools:
- `locate` — exact substring (env var, symbol, error code) or `/regex/`; no literal + `include` globs lists files; prefer `mode=count`, `files` or `locations`
- `search` — one call per conceptual question; use `include` / `exclude` Gitignore-style globs to scope files (same syntax as `locate`)
- `expand` — more context in the same file when `truncated: true` (`file_path` + `anchor_line`)
- `find_related` — similar code in other files (hits may also be snippets; use `expand` if truncated)

Call shapes:
- `locate(literal="<exact substring>")` — prefer `mode="locations"`/`"count"`
- `search(query="<natural language>", include=["src/auth/**"])` — use the same `include` / `exclude` globs on `locate` when scoping an exact-string search

Stop rules:
- Literal in the request → `locate`, not `search`
- One `search` per question — no paraphrase retries
- `expand` only if the snippet doesn't already answer
- Read only to edit a path Miru already found, not to explore

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
| Same file, more context | Miru MCP `expand` on `truncated: true` | Re-search, Read whole file |
| Similar code elsewhere | Miru MCP `find_related` | Grep chains |
| Search docs or config | Miru `search` | Grep README paths |
| Edit a known file:line | Read (after Miru found it) | Read-before-search |

### MCP workflow

1. Call `search`; add `repo` only for another repo.
2. For exact literals, call `locate` (prefer `mode=count` or `locations`).
3. On `truncated: true`, call `expand` — only if the snippet doesn't already answer.
4. Use `find_related` to trace similar code in other files — not for more context in the same file.
5. Read via `absolute_path` only when editing or when `expand` still lacks context.

### CLI fallback (no MCP in this session)

```bash
miru search "authentication flow" .
miru locate DATABASE_URL . --mode locations
miru expand src/auth.ts 42 .
miru find-related src/auth.ts 42 .
```

After large refactors or CLI-only use, run `miru clear <path>` to rebuild the disk cache.
If `miru` is not on `$PATH`, use `bunx @takara-ai/miru-code@latest`.
