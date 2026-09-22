---
name: miru
description: Use Miru Code Search when the user asks where code lives, how behavior is wired, or what related code paths exist in a repo. Prefer this for conceptual code exploration over grep, glob, or broad file reads.
---

# Miru Code Search

Use Miru MCP as the default code-exploration path when it is available.

## When to use it

Exact token (identifier, quoted string, env var, error code) → `locate`. Otherwise → `search` —
e.g. "where is auth wired?", "what handles this behavior?", "find related code for this file/line".

## Workflow

1. Literal in the request? `locate(literal="<token>", repo="<project root>")` — prefer `mode="locations"`/`"count"`.
2. Otherwise `search(query="<question>", repo="<project root>")` once.
3. `truncated: true`? `expand` with `file_path`/`anchor_line` — only if the snippet doesn't already answer.
4. `find_related` for similar code elsewhere, not more context in the same file.
5. Read files directly only after Miru has already located the path.

## If Miru tools report credential errors

Only call `auth` in direct response to a tool error saying credentials are missing, expired,
rejected, invalid, or unauthorized — never speculatively, since it starts a real sign-in prompt.
`auth` with no arguments starts a login and returns a URL and a short code — show both to the
user. Once they confirm, call `auth` again with `{"action": "check"}`. If still pending, wait
for the user to confirm again before re-checking — don't poll in a tight loop.
