# Contributing to Miru

## Setup

1. Install [prek](https://github.com/j178/prek), a Rust reimplementation of [pre-commit](https://pre-commit.com/):

   ```bash
   brew install prek   # or: pip install prek / cargo install prek
   ```

2. Clone and install:

   ```bash
   git clone https://github.com/takara-ai/miru-code.git && cd miru-code
   bun install && cp .env.example .env.local
   bun test && bun run typecheck
   ```

   `bun install` runs `prek install --install-hooks` (via the `prepare` script) if `prek` is on your `PATH`, wiring up the git hooks below. If `prek` isn't installed yet, `prepare` skips silently — install it and run manually:

   ```bash
   prek install --install-hooks
   ```

## Pre-commit hooks

Driven by [`.pre-commit-config.yaml`](.pre-commit-config.yaml). Hooks run:

- Standard checks (trailing whitespace, end-of-file fixer, YAML/JSON validity, large files, merge conflicts, private keys, mixed line endings)
- `commitizen` on commit messages (Conventional Commits format)
- `biome check .` (lint)

To run all hooks against the whole repo without committing:

```bash
prek run --all-files
```

## Commit message standards

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

- `feat: add new search hook`
- `fix: correct chunking boundary`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, etc.

Releases and the changelog are generated from these via [release-please](release-please-config.json) — non-conforming commit messages will be rejected by the commit-msg hook.

## Pull request process

- Do NOT push directly to `main`.
- Create a branch, open a PR, keep it focused and small.
- Ensure `bun test`, `bun run typecheck`, and `bun run lint` all pass.
- Rebase on the latest `main` before requesting review.

## Code quality

- [Biome](https://biomejs.dev/) handles linting and formatting: `bun run lint`, `bun run lint:fix`.
- TypeScript strictness is enforced via `bun run typecheck`.

## Questions?

Contact jordan@takara.ai
