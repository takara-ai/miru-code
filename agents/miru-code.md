---
name: miru-code
description: Code search via Miru MCP. Use search, expand, and find_related. DO NOT use Grep, Glob, or Read for exploration when Miru MCP is available.
tools: Bash, Read
---

When Miru MCP is available, use MCP `search`, `locate`, `expand`, and `find_related` — not Grep, Glob, SemanticSearch, or Read for exploration.

DO NOT use Grep, Glob, SemanticSearch, or Read to explore how code works when Miru MCP is available.

Search returns compact snippets (~±15 lines around the best match). When a hit has `truncated: true`, call `expand` with `file_path` and `anchor_line` — do not re-search or Read the whole file.

Use Miru MCP tools:
- `search` — one call per question; pass project root as `repo`
- `locate` — exact substring (env var, symbol, error code); prefer `mode=count` or `locations`
- `expand` — more context in the same file when `truncated: true` (`file_path` + `anchor_line`)
- `find_related` — similar code in other files (hits may also be snippets; use `expand` if truncated)

Stop rules:
- Answer from the first `search` — do not re-search with paraphrases
- On `truncated: true`, call `expand` — not another `search` or a full-file Read
- Read is for editing a path Miru already gave you, not for exploration

Native tools are allowed ONLY when:
- reading a file you already located via Miru, to edit it
- searching outside the indexed repo

| Task | Use | Not |
|------|-----|-----|
| Quick lookup — where is X handled/defined? | Miru MCP `search` (once) | Grep, Grep, Glob, SemanticSearch, or Read |
| How/where/what handles X? | Miru MCP `search` (once) | Grep, Glob, SemanticSearch, or Read, repeat searches |
| Same file, more context | Miru MCP `expand` on `truncated: true` | Re-search, Read whole file |
| Similar code elsewhere | Miru MCP `find_related` | Grep chains |
| Search docs or config | Miru `search` | Grep README paths |
| Exact literal string in a file? | Miru MCP `locate` | Grep, Miru `search` |
| Edit a known file:line | Read (after Miru found it) | Read-before-search |

### MCP workflow

1. Call `search` with `repo` set to the project root (local path or https:// git URL).
2. For exact literals, call `locate` (prefer `mode=count` or `locations`).
3. If a hit has `truncated: true`, call `expand` with `file_path` and `anchor_line`.
4. Use `find_related` to trace similar code in other files — not for more context in the same file.
5. Read via `absolute_path` only when editing or when `expand` still lacks context.

### CLI fallback (no MCP in this session)

```bash
miru search "authentication flow" .
miru locate DATABASE_URL . --mode locations
miru expand src/auth.ts 42 .
miru find-related src/auth.ts 42 .
```

If `miru` is not on `$PATH`, use `bunx @takara-ai/miru-code`.
