# Copilot routing: repeated evaluation — 27 October 2026

The final confirmation completed **36/36 sessions**, with three repeats of six
cases in both Miru arms. No native search bypass or context-rule violation
executed. All six delegated children used Miru. All 12 answers about numeric
returns without declared units avoided adding units, confirmed by manual review.

Normal Copilot still attempted native search three times. The hook rejected
those calls and Copilot recovered. The result demonstrates enforcement in these
scenarios, rather than perfect voluntary adherence to the instructions.

## Final confirmation

| Observation | Normal Copilot with Miru | Selected `miru-code` |
|---|---:|---:|
| Sessions completed / answer checks passed | 18/18 | 18/18 |
| Correct first attempted exploration tool | 12/15 | 15/15 |
| Correct first successfully executed exploration tool | 15/15 | 15/15 |
| Native searches attempted / executed | 3 / 0 | 0 / 0 |
| Context-rule violations attempted / executed | 4 / 0 | 9 / 0 |
| Unsupported-unit answers on unitless fixtures | 0/6 | 0/6 |
| Related-code cases using `find_related` | 3/3 | 3/3 |
| Delegated investigations with actual child Miru calls | 3/3 | 3/3 |
| Native searches by delegated children | 0 | 0 |
| Repository-scope rejections / hook runtime errors | 0 / 0 | 0 / 0 |
| Source write attempts / sessions with source changes | 0 / 0 | 0 / 0 |

The cases were error-string lookup, context reading, conceptual search, related
code, filename listing and delegation. Delegation has its own metric and is
excluded from the first-tool denominator. The hook rejected one `grep`, two
`glob`, twelve `view` and one premature `expand` call. Every session recovered and
completed. These counters do not classify every unnecessary bounded read.

All final sessions used Auto: 34 exposed `gpt-6-luna` and two exposed
`mai-code-1.1-flash`. This remains an exploratory test, not a fixed-model
comparison or an estimate of production compliance rates.

## Cost findings

These findings predate the [normal Copilot cost optimizations](copilot-cost-evaluation.md),
which include a new evaluation and the current local setup.

The specialist shows a modest saving; normal Copilot with Miru does not show a
reliable saving. The raw `usage.json` files contain `totalNanoAiu` and
`aiCreditsStatus`, which give a better comparison than total input tokens alone.
All 54 completed sessions used below report complete credit accounting. Their
session totals include parent and child agents, cache costs and in-session
recovery calls. Agent and provider breakdowns are not added again.

The comparison matches the final six cases, with three repeats per case per arm.
The native control comes from the preceding broad batch; the two Miru arms come
from the final confirmation. It is a comparison across batches, not a fresh
interleaved evaluation of all three arms.

| Setup | Mean reported AI credits per session | Change from native |
|---|---:|---:|
| Native Copilot | 0.1642 | — |
| Normal Copilot with Miru | 0.1491 | −9.2% |
| Selected `miru-code` | 0.1303 | −20.7% |

Auto model selection affects those results. The native error-string case used
MAI in two of its three trials; each final Miru arm used MAI in one trial. After
excluding that mixed-model case, all five remaining cases use GPT-6 Luna for the
main agent. Normal Miru costs **7.6% more** than native on that subset; the
specialist costs **4.4% less**. This subset still differs in child-agent type:
native delegation uses `copilot-search-a`, whose reported child cost is zero.
Miru's custom children consume credits. Delegation alone costs 87.7% more with
normal Miru and 54.5% more with the selected specialist, despite the improved
child routing compliance.

The final normal Miru arm averages 45,761 input and 348 output tokens per session,
versus native's 41,127 and 616. The specialist averages 33,932 and 399. Cached
tokens are included in input totals; they must not be added to those totals or
priced as fresh input. Fewer total tokens alone does not establish lower cost.

The [SDK usage guide](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
documents the session-wide cost field. Credits here are `totalNanoAiu / 1e9`;
[GitHub's billing guide](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
explains model-dependent token and cache pricing. These are CLI-reported credit
costs, not an invoice reconciliation. Miru indexing, embeddings, hosting and any
subscription costs are excluded. The broad batch's one timeout has unknown
usage and remains excluded, not counted as free. Small synthetic fixtures and
three repeats do not establish production savings.

The calculation and per-session raw usage references are saved in
`/tmp/miru-copilot-routing-format-fixed-3x-2026-10-27/cost-analysis.json`.

## Product changes

[The Copilot hook](../src/copilot/routing-guard.ts) uses Miru's file walker,
ignore rules and file-size filter to identify the current repository's indexable
scope. It rejects native indexed searches, directory-listing discovery and the
built-in code-search subagent. Explicit unindexed and external paths remain
available. Code delegation selects the named `miru-code` specialist.

Context permissions come from Miru's returned paths and line ranges. Source reads
must be bounded to those ranges; expansion requires a prior successful range
read and an anchor within it. The parser handles search chunk headers, inline
locate hits and grouped locate output. Context state is isolated between agents;
parallel tool completions merge their state under a lock.

Guidance attached to returned evidence tells the model to use `find_related` for
analogous code and to report bare numeric values unless the implementation,
an identifier or a verified caller establishes a unit. This unit guidance is
advisory; it is not a semantic verifier. The policy also explains Gitignore glob
syntax and tells agents to omit `repo` for the current repository. Invalid
repository paths get a corrective denial instead of crashing the helper.

[The installer](../src/installer/copilot-routing.ts) bundles the helper and
installs a separate owned `~/.copilot/hooks/miru-routing.json`. Installing or
removing the Copilot instructions also installs or removes these assets. Other
user hook files are preserved. The normal agent retains native tools; the named
specialist additionally restricts its available tools.

## What the broader run exposed

Before the last parser correction, the evaluation recorded all **111 planned
outcomes**, covering three trials for every applicable case/arm pair. One initial
model call timed out before making any tool calls. A separate delegation retry
passed; that timeout remains in the evidence. Across those 112 attempts, 111
produced answers after adjudicating the classification issue below.

- The normal Miru arm used the correct first executed tool in 27/27 eligible core
  cases, up from 8/9 in the preceding single-repeat evaluation. The specialist
  scored 27/27, previously 9/9. Their first attempted choices were 25/27 and 26/27.
- No native search executed in either Miru arm. Six completed delegated
  investigations, including the diagnostic retry, used Miru in their children;
  no child made a native search.
- All 12 unitless-number answers avoided unsupported units. The native control
  added units in three of its six equivalent answers. All 12 simulated
  authentication/server failures stopped within the allowed recovery bound.
- A stricter recheck found **two oversized reads** that had executed because the
  first hook parser missed inline/grouped locate formats. Both are retained in
  `strict-policy-regrade.json`; the final confirmation above tests the correction.
- Related-code routing was only 4/6 in that broader batch. Additional guidance
  after tool results improved it to 6/6 in the final confirmation.
- One agent supplied a nonexistent repository path, corrected it and answered
  correctly. The helper logged an error and the harness mislabeled the boundary
  rejection as an index/credentials failure. The helper and evaluator now handle
  that case separately. Raw flags are retained; the adjudication is explicit in
  `all-attempts.json`.

The broader completed answers passed 109/111 raw path/fact checks. One failure
said “first and last 2 characters” rather than the oracle's “first two”; manual
review confirms the expected redaction behavior. Another returned the correct
ignored-file value but omitted the expected path citation. The oracle was kept
unchanged. All nine injection cases actually exposed the canary, with no source
write attempts. Writes, shell and web access were denied by the harness, so this
is not proof of behavior under unrestricted permissions.

The timeout and the recovered classification error stopped batches. Unstarted
cases were completed in separate groups, with explicit mappings to their original
planned slots. Their order differs from the initial shuffle. No raw result was
overwritten to replace a failure with a retry.

## Evidence and validation

The [harness guide](copilot-evaluation.md) documents setup and controls. Main local
evidence directories are:

- Broad run, continuations and regrade:
  `/tmp/miru-copilot-routing-guard-3x-v2-2026-10-27`
- Separate timeout diagnostic retry:
  `/tmp/miru-copilot-guard-delegation-retry-2026-10-27`
- Final 36-session confirmation:
  `/tmp/miru-copilot-routing-format-fixed-3x-2026-10-27`

The broad directory contains `combined-results.json`, the continuation manifests,
`all-attempts.json`, `comparison-data.json`, `strict-policy-regrade.json` and a
snapshot of the source before the parser correction. The final directory contains
`report.md`, `results.json`, `comparison-final-data.json` and each session's raw
trace, installed helper and hook audit.

Development evidence is separate: an eight-session initial smoke test, a
two-session directory-guard smoke test, and a 14-session interrupted pilot that
revealed directory-listing discovery. Those are excluded from the main tables.
The main batches contain 148 attempts: 111 planned trials, one diagnostic retry
and 36 final confirmation trials.

The corpus and original prompts were unchanged. Corpus SHA-256:
`694171d175552e4de2013f54e2f3080e7e9b9d953f6116d8865a096a8206bf26`.
Broad-run runtime SHA-256:
`2b3bd33d748cc25447f4da27710eec955e0fdedd0e8151dbececfe27b4ac5ffe`.
Final runtime SHA-256, verified unchanged after evaluation:
`7edca76c9ead383ba3e4f79407b5f1c8e27a9a2ef08d4dcd5404711809a1a243`.

All 36 final installed helper bundles matched the user's installed helper,
SHA-256 `5b4d831c92a728ae715467a3064ddc0d0bbd0cf337a26254ed3a5b77a0c6b771`.
The local instructions, profile and hooks are updated. Their prior versions are
backed up at `~/.copilot/miru-backups/format-1793118808028`. Restart Copilot to
refresh the policy and profile. The normal `copilot` session now receives the
routing hook; `copilot --agent=miru-code` selects the additional tool restriction.

Validation passed: **105 tests**, 653 assertions, type checking and Biome checks.
Tests exercise actual standalone hook processes, all observed locate formats,
ignored/external paths, directory discovery, concurrent reads, agent isolation,
bad repository arguments, installation and cleanup. No package was published.

These are small synthetic fixtures used to guide the fixes, not held-out tasks.
Hook disable settings, runtime failures and timeouts can defeat this helper; shell
searches are outside its native-search checks. It is a routing aid, not a security
boundary. This evaluates GitHub Copilot CLI 1.0.100 with the real local Miru
backend, not VS Code, Copilot cloud agent or Microsoft 365 Copilot.
