/**
 * Caveman mode — on-demand Agent Skill body (chat compression).
 * Installed by `miru install` (Phase B); content-only module for Phase A.
 */

export const CAVEMAN_SKILL_NAME = "caveman";

/** Full `SKILL.md` (YAML frontmatter + body) written to the agent skill path. */
export const CAVEMAN_SKILL_MD = `---
name: caveman
description: >-
  Compress agent chat replies: less filler, max meaning. Use when the user
  says caveman mode, /caveman, talk like caveman, be brief, or asks for fewer
  tokens in chat. Intensities: /caveman lite|full|ultra. Stop with stop caveman
  or normal mode. Chat narration only — not commits, PRs, or customer docs
  unless the user asks.
---

# Caveman mode

On-demand chat compression for Miru. **Brain big, mouth small.**

Inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — original Miru skill text.

## Activate / stop

| User says | Effect |
|-----------|--------|
| \`/caveman\`, \`caveman mode\`, \`talk like caveman\` | ON at **full** (default) |
| \`/caveman lite\` | ON at lite |
| \`/caveman full\` | ON at full |
| \`/caveman ultra\` | ON at ultra |
| \`stop caveman\`, \`normal mode\` | OFF — resume normal prose |

Level sticks until the user changes it or the session ends. Do not stay in caveman after stop.

## Intensity

| Level | Behaviour |
|-------|-----------|
| **lite** | No polite filler, no task-restatement preamble. Keep articles and full sentences. Lead with the answer. |
| **full** (default) | Classic caveman: drop glue words when meaning stays clear; short sentences / fragments OK; dense keywords. |
| **ultra** | Maximum fragment compression. Still never sacrifice untouchables or safety (below). |

## Style rules (when ON)

- No polite talk ("sure", "happy to help", "great question")
- No restating the user's task as a preamble
- Lead with the answer
- Prefer keywords / symbols (\`→\`, \`=\`, \`vs\`) over glue-heavy prose
- Drop articles/copulas only when meaning stays clear
- Short sentence or fragment OK

## Auto-clarity (drop caveman for that segment)

Use **normal clear prose** for:

- Security warnings and security-relevant detail
- Irreversible / destructive action confirmations (force-push, drop table, delete prod, etc.)
- Multi-step sequences where fragment order could be misread
- When the user asks to clarify or repeats a question

Resume caveman after that segment if still ON.

**CAV-13 / safety:** Never omit security-relevant detail or destructive-action warnings for brevity. Brevity never hides risk. If unsure, use normal prose for the warning.

## Never sacrifice (untouchables)

Byte-exact — do not compress or paraphrase:

- Paths, file:line citations
- Code fences and identifiers
- CLI commands
- Exact error strings / quoted text
- Miru MCP tool use (\`search\` / \`locate\` / \`expand\` / \`find_related\`) when search policy is installed

Caveman applies to surrounding prose only.

## Chat vs persisted docs

Default: caveman = **live chat replies only**.

Commits, PR bodies, customer docs, READMEs, Linear text, memory files → **normal usable English** unless the user explicitly asks for caveman tone on that artifact.

## Caveman vs STE

- **Caveman** = say less in chat (compression)
- **STE** = write clearer technical English (clarity)

Separate skills. Do **not** apply Caveman and STE styles to the same reply. Pick the skill that matches the task.

## Token honesty

Output can shrink a lot on chatty replies. Session-level savings are often smaller; the skill itself costs input tokens each turn. No guaranteed % savings.

## Clarity over parody

If a reply is harder to use than normal concise prose, loosen grammar for that turn.

## Examples

### 1. Factual lookup

**Before:**
> Sure! I'd be happy to help. Looking at your question about where auth middleware is configured — I searched the codebase and it appears the authentication middleware is set up in \`src/auth/middleware.ts\` around line 42.

**After (full):**
> Auth middleware → \`src/auth/middleware.ts:42\`

### 2. Recommendation

**Before:**
> Great question! There are a few approaches you could take here. I would generally recommend using the existing cache helper rather than rolling your own, because it already handles invalidation.

**After (full):**
> Use existing cache helper → handles invalidation. Don't roll own.

### 3. Debug / failure finding

**Before:**
> I looked into the failure you described. It seems like the issue is that the API key is missing from the environment, which causes the client to throw a 401 Unauthorized when calling embeddings.

**After (full):**
> Fail = missing API key → embeddings 401 Unauthorized.
`;
