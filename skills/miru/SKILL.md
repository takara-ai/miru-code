---
name: miru
description: Use Miru Code Search before reading or grepping whenever you need to find code you can't already name by path — starting a task in unfamiliar code, locating where to make an edit, answering how/where/why something works, tracing callers or similar code, or looking up docs/config. Also for exact identifiers, env vars and error strings (`locate`). Also does regex and file-by-name listing. Prefer over Grep, Glob and broad file reads, except for files Miru does not index.
---

# Miru Code Search

Use Miru MCP as the default code-exploration path when it is available.

## When to use it

Reach for Miru first, before opening files, whenever you don't already know the exact path:

- starting a task in code you haven't seen, to find the entry points
- finding where to make an edit ("where is auth wired?", "what handles this behavior?")
- answering how, where or why something works
- tracing related code ("find related code for this file/line")
- checking docs or config

Exact token (identifier, quoted string, env var, error code) → `locate`. Otherwise → `search`.

`locate` also takes a regex wrapped in slashes (`locate(literal="/foo\w+Bar/")`, `/…/i` to ignore case) and, with no literal, lists files by name: `locate(include=["**/*.test.ts"])`. Use `mode="files"` to get just the matching paths. Grep/Glob are only needed for files Miru does not index (lockfiles, binaries, generated or git-ignored files).

## Workflow

1. Literal in the request? `locate(literal="<token>")` — prefer `mode="locations"`/`"count"`.
2. Otherwise `search(query="<question>")` once.
3. `truncated: true`? The header gives `path:start-end Symbol` and `anchor_line`: read exactly those lines (ranged read, `offset`/`limit`), not the whole file — only if the snippet doesn't already answer. `expand` is the fallback for neighbouring chunks.
4. `find_related` for similar code elsewhere, not more context in the same file.
5. Read files directly only after Miru has already located the path.

`repo` is optional, set it for another repo. Reuse it on follow-up calls.

## If Miru tools report credential errors

Only start Takara device login with `auth` in direct response to a tool error saying credentials are missing, expired,
rejected, invalid, or unauthorized — never speculatively, since it starts a real sign-in prompt.
`auth` with no arguments starts a login and returns a URL and a short code — show both to the
user. Once they confirm, call `auth` again with `{"action": "check"}`. If still pending, wait
for the user to confirm again before re-checking — don't poll in a tight loop.

On explicit user request, configure SageMaker through `auth` with `action: "sagemaker"`,
`endpoint_arn`, and `aws_profile` (an existing AWS profile). This validates the endpoint before
replacing stored credentials and does not open a browser login.
