# Normal Copilot: lower search overhead — 27 October 2026

Normal Copilot with Miru now uses fewer credits on the repeated fixture tasks.
The final confirmation used **24.7% fewer reported Copilot credits** than the
previous version on the same six cases, with three repeats per case. Both batches
exposed the same model mix: 17 GPT-6 Luna sessions and one MAI session.

For the five cases whose main model was GPT-6 Luna throughout, the final version
used **21.5% fewer credits than the previous Miru integration** and **12.1% fewer
than native Copilot**. These are observed costs on small fixtures, not production
savings estimates. Auto routing and cache state were not controlled.

## Cost comparison

This table excludes the error-string case, where Auto selected different models.
Each row contains 15 sessions: three repeats of conceptual search, context,
related code, filenames and delegation.

| Setup | Mean reported AI credits / session |
|---|---:|
| Previous normal Copilot with Miru | 0.1392 |
| Fresh native Copilot control | 0.1244 |
| Optimized normal Copilot with Miru | **0.1093** |

Native delegation still uses a separate `copilot-search-a` child, whose reported
cost is zero. Thus this controls the main model, not the entire agent
configuration. The native controls came from the 72-session batch immediately
before the final confirmation; the previous Miru baseline came from the preceding
[routing evaluation](copilot-routing-repeat-evaluation.md). This is a comparison
across batches, not a fixed-model randomized experiment.

Across all six matched cases, previous and final normal Miru mean costs were
0.1491 and 0.1122 credits. Mean input fell from 45,761 to 33,033 tokens; mean tool
calls fell from 2.44 to 1.39. Eleven successful source reads became unnecessary:
the initial Miru results already contained the required source. Both batches
passed all 18 path/fact checks. Mean wall time fell from 12.56 to 11.25 seconds;
this is not a controlled latency benchmark.

Some tasks still have overhead. In the final confirmation, filename listing cost
13.4% more than the fresh native control and delegation cost 6.1% more. Conceptual
search cost 33.1% less, context explanations 22.3% less and related-code lookup
11.7% less. The error-string case is excluded from these model-matched claims.
The broader batch also showed overhead for trivial regex, absent-symbol and
explicit ignored-file lookups.

Costs use complete CLI `totalNanoAiu` accounting, divided by `1e9` for AI credits.
This includes parent and child agents, cache reads/writes and in-session retries.
Per-agent/provider breakdowns are not added again. Missing cost is never zero.
All 90 main attempts reported complete cost and completed without setup errors.
Miru indexing, embeddings, hosting and subscriptions are excluded; no invoice
reconciliation was performed. See the
[Copilot SDK usage guide](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
and [GitHub billing guide](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing).

## Implementation

- Copilot receives compact MCP instructions and four shorter tool descriptions,
  selected from its MCP initialization client name. The available tools, schemas,
  validation and credential-recovery capability stay the same. Tools remain
  visible upfront.
- Search and related-code results return complete small chunks up to 12 lines
  and 2,000 characters. Larger chunks retain bounded snippets. This avoids a
  second model call merely to read a short function.
- The installed Copilot policy requests `context_lines=8` for behavior lookups,
  uses compact modes for file/count questions, and keeps routine work in the main
  agent. Explicit delegation still selects `miru-code`.
- The post-tool reminder is shorter and omitted for file/count results and
  unindexed reads. It retains range, related-code and evidence-based unit guidance.
  The native-search, child-routing and context-range checks remain enabled.
- The harness now saves complete reported credit cost in `billing` and includes
  a cost table. Failed attempts with known cost would remain in that table.

Repository WordPiece size checks measure these text reductions; they are not the
Copilot model's billed token counts:

| Text | Before | After |
|---|---:|---:|
| Installed Miru policy, including markers | 867 | 513 |
| MCP definitions and instructions | 2,500 | 1,938 |
| Per-result evidence reminder | 99 | 56 |

Other MCP clients retain their existing definitions and snippet behavior.

## Compliance and validation

The broad run completed **72/72 sessions**: 33 native controls and 39 normal Miru
trials, including three repeats of every applicable case. All answer checks
passed. Normal Miru had no executed native search, context violation, unsupported
unit claim, source write or helper error. All three delegated children used
Miru, and all six simulated failures stopped within the recovery bound. One
attempted native search was blocked. However, one related-code trial used
semantic search instead of `find_related`.

The evidence reminder was made explicit about using `find_related` rather than
search for analogous code. The final **18/18-session** confirmation tested that
correction across all six key cases, with three repeats each:

| Observation | Final normal Copilot with Miru |
|---|---:|
| Sessions completed / answer checks passed | 18/18 |
| Correct first attempted exploration tool | 15/15 |
| Correct first executed exploration tool | 15/15 |
| Native search attempts / executed searches | 0 / 0 |
| Context violation attempts / executions | 0 / 0 |
| Related-code trials using `find_related` | 3/3 |
| Delegated investigations with child Miru calls | 3/3 |
| Native child searches | 0 |
| Unsupported-unit answers on unitless fixtures | 0/6 |
| Source writes / changed-source sessions / helper errors | 0 / 0 / 0 |

All six unitless-number answers were manually reviewed. The answer oracle remains
a modest path/fact check, not a semantic judge. Source injection was exposed in
the broader batch, with no write attempts. Writes, shell and web were denied by
the harness; this does not establish behavior under unrestricted permissions.
The fixtures were used to guide development and are not held-out tasks.

Validation passed: **165 tests across 12 files**, type checking and Biome checks.
Tests cover negotiated compact definitions, identical tool schemas, complete
short chunks, retained truncation for large/wide chunks, standalone hook bounds,
child isolation, installation, protocol compatibility and complete-cost parsing.
The direct production CLI MCP entrypoint was also checked without model calls.

## Local installation and evidence

At evaluation time, the local policy, named profile and hook were updated, and
Copilot's Miru MCP entry ran the unpublished checkout's `src/cli.ts mcp` with Bun.
Development benchmark mode was turned off to
avoid its extra output in daily use. Both before/after evaluation backends already
had benchmark mode off, so that configuration change does not explain the
measured savings. These runs preceded the package release.

The pre-optimization setup is backed up at
`~/.copilot/miru-backups/cost-1793120978903`.
All 18 final session helper bundles match the installed helper, SHA-256
`8b70fa871f1d71178f7c71eb06167f21c86c035a4f0be1602c27ab3a086b756c`.

Evidence directories:

- Broad 72-session run: `/tmp/miru-copilot-cost-optimized-3x-2026-10-27`
- Final 18-session confirmation: `/tmp/miru-copilot-cost-final-3x-2026-10-27`
- Separate three-session smoke test: `/tmp/miru-copilot-cost-smoke-2026-10-27`
- Previous six-case baseline:
  `/tmp/miru-copilot-routing-format-fixed-3x-2026-10-27`

The final directory contains `cost-analysis.json`, `analyze-cost.ts`, `installation-verification.json`,
raw usage and tool traces. `cost-analysis.json` preserves both phases and their
cost comparisons; the broader phase is not silently replaced by the correction.
The corpus and original prompts were unchanged. Corpus SHA-256:
`694171d175552e4de2013f54e2f3080e7e9b9d953f6116d8865a096a8206bf26`.
Broad runtime SHA-256:
`7bcc5f49666716372cad9e26e7f7686015ad5eb55418fec3d454d548ab2eca9a`.
Final runtime SHA-256, verified unchanged after evaluation:
`ffdabdecf9e152fd0737a548bb65750de40c694ecde704766c5ac163f22ff866`.

This evaluates GitHub Copilot CLI 1.0.100 using Auto and the real local Miru
backend. VS Code, cloud agent and Microsoft 365 Copilot were not evaluated.
The hook remains a routing aid with the runtime/disable limits documented in the
[harness guide](copilot-evaluation.md), not a security boundary.

## Release verification

The release was prepared in a clean checkout containing only the Copilot changes,
excluding concurrent embedding and ranking work from the development checkout.
All 891 tests, type checking and linting passed. Four fresh normal Copilot smoke
sessions against the real backend passed their answer checks, with no executed
native searches, context violations or unsupported-unit answers. The delegated
child used Miru. One analogous-code investigation used `miru/search` rather than
`find_related`; that preference remains advisory. The earlier three-for-three
observation is not a guarantee of voluntary semantic tool selection.

Release smoke evidence: `/tmp/miru-copilot-release-smoke-2026-10-27`.
