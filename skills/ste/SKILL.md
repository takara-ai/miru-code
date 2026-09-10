---
name: ste
description: >-
  Clear technical English for docs, runbooks, errors, and release notes.
  Use when the user says STE, ASD-STE100, /ste, de-slop, write for non-native
  readers, or asks to rewrite technical prose. Pragmatic by default; strict
  when they ask for STE compliance. Not for marketing or brand copy. Not for
  ultra-compressed chat telegraph style.
---

# STE writing (Simplified Technical English)

On-demand clear technical writing for Miru. **Short complete sentences. Keep articles.**

Unofficial aid inspired by [ASD-STE100](https://www.asd-ste100.org) Issue 9 themes.
**Not ASD-certified. Not ASD-endorsed.** Full dictionary compliance needs the official standard at asd-ste100.org.

Inspired by prior art ([AminBlg/SimpleEnglish](https://github.com/AminBlg/SimpleEnglish), [woosal STE kit](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop)) — original Miru skill text. Do not vend copyrighted ASD dictionary word lists.

## Activate

| User says | Effect |
|-----------|--------|
| `/ste`, `STE`, `write in STE`, `de-slop this` | ON **pragmatic** (default) |
| `ASD-STE100`, `strict STE`, `STE compliance` | ON **strict** — also load `references/rules.md` |
| Check / audit my STE | Use `references/checklist.md` |

## Task flow

1. Select mode (pragmatic vs strict)
2. Classify text as **procedural** or **descriptive**
3. Pick one consistent term per concept
4. Apply core rules below
5. Run **self-check**
6. Deliver

## Modes

| Mode | Behaviour |
|------|-----------|
| **Pragmatic** (default) | Structural rules + consistent terms. Domain nouns/verbs OK (`webhook`, `deploy`, `commit`). |
| **Strict** | Stricter vocabulary discipline. Tell the user full compliance needs the official ASD dictionary: https://www.asd-ste100.org — then load `references/rules.md`. |

Cite rule numbers **only** when they appear in `references/rules.md`. Do not invent ASD rule IDs.

## Core rules (pragmatic)

- Short **complete** sentences. Keep `a` / `an` / `the` and `that`. No telegraph omission.
- No semicolons — use two sentences.
- **Procedural:** imperative; about 20 words max per sentence; one instruction per sentence; **condition BEFORE command**.
- **Descriptive:** simple tenses; about 25 words max per sentence; one topic per paragraph.
- Active voice; simple tenses; avoid present-perfect stacks and comma "-ing" padding.
- Prefer modals `can` / `will` / `must`. Avoid `should` / `would` / `may` / `might` / `could` in instructions.
- One name per concept in the document (no check/verify/confirm/validate roulette).
- Warnings: state the command or condition first, then the risk.

## Untouchables

Never alter:

- Code fences, identifiers, CLI flags, paths
- Quoted errors, product/API names
- Required safety conditions, limits, versions

If shortening would drop a required qualifier, keep the longer clear sentence.
Miru MCP tool use stays intact when search policy is installed.

## Not for marketing

Do **not** apply STE to marketing, brand, or persuasive copy. Decline and offer a docs-oriented rewrite instead.

## Slop → plain (examples)

| Slop | Plain |
|------|-------|
| It is worth noting that the service is highly robust | The service stays up if the primary node fails |
| You should consider carefully validating the input | You must validate the input |
| Feel free to simply leverage the existing utility | Use the existing utility |

## Before / after

**Before (slop):**
> It is worth noting that you should carefully ensure the migration has completed successfully before you proceed to delete the old volume, as doing so might potentially result in irreversible data loss.

**After (STE pragmatic):**
> Wait until the migration is complete. Then delete the old volume. If you delete the volume too early, you will lose data permanently.

## Self-check (before delivery)

1. Sentences complete with articles where needed?
2. One instruction per procedural sentence; condition before command?
3. Terms consistent; modals are can/will/must where instructions appear?
4. Code, paths, errors, and safety limits untouched?

For a longer audit, read `references/checklist.md`.

## References

- `references/rules.md` — fuller paraphrased rule catalog (strict / audit)
- `references/checklist.md` — extended self-check patterns
