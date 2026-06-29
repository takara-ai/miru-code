---
name: miru
description: Use Miru Code Search when the user asks where code lives, how behavior is wired, or what related code paths exist in a repo. Prefer this for conceptual code exploration over grep, glob, or broad file reads.
---

# Miru Code Search

Use Miru MCP as the default code-exploration path when it is available.

## When to use it

Use Miru when the user asks things like:

- where is auth wired?
- what code handles this behavior?
- find related code paths for this file and line
- search the repo by meaning instead of grep

Do not use Miru for exact literal lookups such as:

- env var names
- exact error codes
- quoted string matches

## Workflow

1. Call `search` once with `repo` set to the project root.
2. If a result has `truncated: true`, call `expand` with `file_path` and `anchor_line` (or `start_line`).
3. Use `find_related` only for similar code in other files.
4. Read files directly only after Miru has already identified the relevant path.

## Tool preference

- Prefer Miru `search` over grep/glob/bash exploration for conceptual questions.
- Prefer Miru `expand` over rereading whole files when a hit is truncated.
- Prefer Miru `find_related` over repeated search paraphrases when tracing similar logic.
