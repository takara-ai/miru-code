/**
 * STE mode — on-demand Agent Skill + references (clear technical English).
 * Unofficial ASD-STE100-inspired aid; not ASD-certified.
 */

export const STE_SKILL_NAME = "ste";

export interface SteReferenceFile {
  relativePath: string;
  content: string;
}

/** Compact pragmatic `SKILL.md` (YAML frontmatter + body). */
export const STE_SKILL_MD = `---
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
| \`/ste\`, \`STE\`, \`write in STE\`, \`de-slop this\` | ON **pragmatic** (default) |
| \`ASD-STE100\`, \`strict STE\`, \`STE compliance\` | ON **strict** — also load \`references/rules.md\` |
| Check / audit my STE | Use \`references/checklist.md\` |

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
| **Pragmatic** (default) | Structural rules + consistent terms. Domain nouns/verbs OK (\`webhook\`, \`deploy\`, \`commit\`). |
| **Strict** | Stricter vocabulary discipline. Tell the user full compliance needs the official ASD dictionary: https://www.asd-ste100.org — then load \`references/rules.md\`. |

Cite rule numbers **only** when they appear in \`references/rules.md\`. Do not invent ASD rule IDs.

## Core rules (pragmatic)

- Short **complete** sentences. Keep \`a\` / \`an\` / \`the\` and \`that\`. No telegraph omission.
- No semicolons — use two sentences.
- **Procedural:** imperative; about 20 words max per sentence; one instruction per sentence; **condition BEFORE command**.
- **Descriptive:** simple tenses; about 25 words max per sentence; one topic per paragraph.
- Active voice; simple tenses; avoid present-perfect stacks and comma "-ing" padding.
- Prefer modals \`can\` / \`will\` / \`must\`. Avoid \`should\` / \`would\` / \`may\` / \`might\` / \`could\` in instructions.
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

For a longer audit, read \`references/checklist.md\`.

## References

- \`references/rules.md\` — fuller paraphrased rule catalog (strict / audit)
- \`references/checklist.md\` — extended self-check patterns
`;

export const STE_RULES_MD = `# STE rules catalog (Miru paraphrase)

Unofficial structural catalog for Miru STE **strict** / audit use.
Themes follow ASD-STE100 Issue 9. **Not a copy of the official standard. Not a dictionary.**
Official standard and dictionary: https://www.asd-ste100.org

Cite the rule IDs below only. Do not invent other ASD numbers.

## Words and terms

### R1 — One name per concept
Pick one term for each idea in the document. Do not rotate synonyms (\`check\` / \`verify\` / \`validate\`) for the same action.

### R2 — Approved instruction modals
In procedures, prefer \`can\`, \`will\`, \`must\`. Avoid \`should\`, \`would\`, \`may\`, \`might\`, \`could\` when you give an instruction.

### R3 — Keep articles and "that"
Write complete noun phrases. Keep \`a\`, \`an\`, \`the\`, and \`that\`. Do not drop them for brevity.

### R4 — No semicolon glue
Do not join two ideas with a semicolon. Use two sentences.

## Sentences

### R5 — Procedural length
In procedures, aim for about **20 words or fewer** per sentence. Give **one instruction** per sentence.

### R6 — Descriptive length
In descriptions, aim for about **25 words or fewer** per sentence. Keep **one topic** per paragraph.

### R7 — Condition before command
State the condition first. Then give the command.

Example: \`If the node is down, stop the job.\`
Not: \`Stop the job if the node is down.\` when the condition is the safety gate.

### R8 — Active voice and simple tense
Prefer active voice and simple present or simple past. Avoid stacked present-perfect and trailing "-ing" clauses that hide the actor.

## Safety

### R9 — Warning shape
For destructive actions: state the command or the condition clearly, then state the risk.

Example: \`Do not run this on production. This command deletes all rows in the table.\`

### R10 — Do not drop required limits
If a version, limit, or condition is required for safety, keep it. Clarity beats compression.

## Software examples

| Weak | Stronger STE shape |
|------|--------------------|
| You might want to restart the pod | Restart the pod |
| Ensure that connectivity has been established | Make sure the connection is up |
| After having deployed the chart, proceed to verify | Deploy the chart. Then check the release status |

## Dictionary

Miru does **not** ship the ASD approved-word list. For strict vocabulary compliance, use the official dictionary from asd-ste100.org. Domain technical nouns (\`Kubernetes\`, \`webhook\`, \`IAM\`) stay as product names (untouchable).
`;

export const STE_CHECKLIST_MD = `# STE extended checklist (Miru)

Use this for **check mode** / audits after a rewrite. Unofficial. Not ASD certification.

## Structure

- [ ] Procedural sentences ≈ ≤20 words; one instruction each
- [ ] Descriptive sentences ≈ ≤25 words; one topic per paragraph
- [ ] Condition appears before the command when safety depends on it
- [ ] No semicolons used as sentence glue
- [ ] Articles and \`that\` kept (not telegraph)

## Wording

- [ ] One term per concept across the document
- [ ] Instruction modals are can / will / must (not should / might / could)
- [ ] Active voice; simple tenses
- [ ] No marketing filler ("robust", "seamless", "it is worth noting")

## Safety and precision

- [ ] Destructive steps warn with command/condition first, then risk
- [ ] Required versions, limits, and conditions still present
- [ ] Code, paths, CLI, quoted errors unchanged

## Scope

- [ ] Not applied to marketing / brand copy
- [ ] Strict mode users pointed at https://www.asd-ste100.org for the official dictionary
- [ ] Disclaimer remembered: Miru STE is unofficial / not certified

## Delivery

- [ ] Self-check in the main skill completed before send
`;

/** Files written under the skill directory beside `SKILL.md`. */
export const STE_REFERENCE_FILES: SteReferenceFile[] = [
  { relativePath: "references/rules.md", content: STE_RULES_MD },
  { relativePath: "references/checklist.md", content: STE_CHECKLIST_MD },
];
