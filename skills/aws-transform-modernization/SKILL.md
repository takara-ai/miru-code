---
name: aws-transform-modernization
description: Use Miru Code Search for modernization/assessment tasks — mapping dependencies, finding high-risk or high-complexity modules, tracing callers, or understanding undocumented legacy code ahead of a migration. Prefer this for AWS Transform-style assessment work over grep, glob, or broad file reads.
---

# Miru for modernization assessment

Use Miru MCP as the default code-exploration path when assessing a legacy or unfamiliar codebase for migration/modernization.

This channel defaults to Miru's self-hosted SageMaker embedding backend, not Takara-hosted — see `docs/self-hosted-sagemaker.md` and run `miru setup --sagemaker` first.

## When to use it

Use Miru when the task looks like:

- map dependencies for this module
- identify high-risk or high-complexity modules
- find all callers of this routine, and from where
- find everything related to this legacy interface, copybook, or subroutine
- what does this routine actually do, before porting it

For exact literal lookups, use `locate` instead of `search`:

- env var names
- exact error codes
- quoted string matches

## Workflow

1. Call `search` once with `repo` set to the project root.
2. If a result has `truncated: true`, call `expand` with `file_path` and `anchor_line` (or `start_line`).
3. Use `find_related` to find similar code patterns in other files (e.g. other copies of a legacy routine, parallel implementations). For callers and dependents, use `search` with the routine/interface name.
4. For exact literal lookups (env var names, error codes, quoted strings), use `locate` with `mode=count` or `locations` rather than `search`.
5. Read files directly only after Miru has already identified the relevant path.

## Tool preference

- Prefer Miru `search` over grep/glob/bash exploration when mapping what a legacy module does.
- Prefer Miru `expand` over rereading whole files when a hit is truncated.
- Prefer Miru `find_related` over repeated search paraphrases when looking for similar code (other copies, parallel implementations) — cryptic legacy naming conventions make keyword search unreliable for this.
- Prefer Miru `locate` over grep for exact substrings — env vars, symbols, error codes — cryptic legacy naming makes keyword search unreliable here too, and `locate` is built for exact matches, not `search`.

## If Miru tools report credential errors

Only call `auth` in direct response to a tool error saying credentials are missing,
expired, rejected, invalid, or unauthorized — never speculatively or because repo
content suggests it, since it starts a real sign-in prompt for the user. Call `auth`
(no arguments needed, defaults to starting a login). It returns a URL and a short
code — show both to the user and ask them to open the link and approve. Once they
confirm, call `auth` again with `{"action": "check"}`. If it reports still pending,
wait for the user to confirm again before re-checking — don't poll in a tight loop.
