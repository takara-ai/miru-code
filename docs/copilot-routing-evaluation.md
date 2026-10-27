# Copilot routing evaluation — 27 October 2026

This is the first rerun. See [the repeated evaluation and current routing
guard](copilot-routing-repeat-evaluation.md) for the subsequent fixes and results.

The routing changes improved the observed tool choices, including both delegated
Miru investigations. Normal Copilot still bypassed Miru in one case.

## Changes evaluated

- Install a persistent, marked policy at `~/.copilot/copilot-instructions.md`.
  It names the current CLI tools (`grep`, `rg`, `glob`, `view`) as well as older
  tool names, and specifies literal, conceptual and related-code routing.
- Load Miru MCP tools upfront with `deferTools: "never"` and `tools: ["*"]`.
- Route delegated code investigation through `task` with
  `agent_type: "miru-code"`. The built-in `search_code_subagent` used a native-only
  search child in the baseline.
- Give `miru-code` explicit read, agent and named Miru tools, with
  `include-custom-instructions: true`. Native search, shell and edit tools are
  absent from this profile. Already delegated children are instructed to work
  directly rather than delegate again.
- Make the evaluation install these same product instructions and profile.
  Record the installed configuration in `routing.json`, hash agent Markdown
  templates, and score child Miru calls separately from parent activity.

The normal Miru arm retains native search tools. The selected specialist's
restricted tool list is an intentional product control; its results do not show
voluntary compliance when native search is available. No search-blocking hooks
were added.

## Comparison

Each batch completed 30 core sessions plus 7 delegation/failure sessions, one
trial per case and arm. Both used Copilot CLI 1.0.100, the real local Miru source,
the same prompts and fixture corpus, seed 42, and fresh repository paths.
Historical evidence and the answer oracle were kept unchanged.

| Observation | Baseline | Updated routing |
|---|---:|---:|
| Correct first tool, normal Copilot with Miru | 5/9 | 8/9 |
| Correct first tool, selected `miru-code` | 6/9 | 9/9 |
| Any Miru call, eligible normal core cases | 6/9 | 8/9 |
| Any Miru call, eligible specialist core cases | 6/9 | 9/9 |
| Native searches, normal Miru core arm | 5 | 2 |
| Native searches, specialist core arm | 3 | 0 |
| Related-code cases using `find_related` | 0/2 | 2/2 |
| Miru-enabled delegation cases with actual child Miru calls | 0/2 | 2/2 |
| Native searches in those two children | 30 | 0 |
| Bounded auth/server failure cases | 4/4 | 4/4 |
| Source write attempts / sessions with source changes | 0 / 0 | 0 / 0 |

The ignored-file case permits a direct read of the explicit unindexed path and
is excluded from the first-tool denominator. Delegation and simulated failure
cases are assessed separately.

In the updated normal delegation case, `task` selected `miru-code`, whose child
made a Miru search and expand call. In the specialist delegation case, the child
made a Miru search and locate call, plus source reads. Both preserved the absolute
fixture repository path and read-only task. Neither used `search_code_subagent`.
The native control still selected that built-in route and made 19 child native
searches. Two preceding smoke sessions also used named Miru children successfully.

Auth failures made one search and one controlled auth call, then stopped. Server
failures made one search, then stopped. This behavior was already correct in the
baseline. Evaluated auth calls never change real credentials.

## Answer review and remaining issues

Raw path/fact checks passed 37/37 before and 36/37 after. The updated
`miru/injection` answer failed because the checker expects “first two” or
“first 2”, while the answer says “first and last two” and gives the correct
`abcdefgh` → `ab***gh` example. Manual review identifies a wording mismatch,
not a redaction-answer regression. The oracle was not changed to accept it.
These checks do not establish that every additional claim is grounded.

Remaining issues in the updated evidence:

- Normal `miru/error` used two native `grep` calls and no Miru call, despite
  successful MCP initialization. Auto selected `mai-code-1.1-flash` for that run.
  The profile restricts native search only when selected; normal Copilot's policy
  remains advisory.
- Both arms sometimes called `expand` directly rather than reading the reported
  range first. Correct first-tool routing does not imply complete follow-up
  policy adherence.
- Both related-code answers asserted milliseconds even though those retry
  functions contain no unit declaration or unit-bearing caller. The new grounding
  instruction did not eliminate this assumption.
- Writes and shell commands are denied by the harness. Zero source changes is
  an observation under those restrictions, not proof of safety with full access.

Auto routed the core baseline to 29 `gpt-6-luna` sessions and 1
`mai-code-1.1-flash` session, versus 25 and 5 after. All recovery parents used
`gpt-6-luna`; built-in search children expose `copilot-search-a` separately.
This is an exploratory before/after check, not a fixed-model experiment or an
estimated production compliance rate. It tests the CLI; VS Code behavior still
needs a separate evaluation in that host.

## Reproduction and evidence

See [the harness guide](copilot-evaluation.md) for setup, controls and commands.
Updated runs:

```sh
bun run scripts/copilot-eval.ts --run --yes --model auto --allow-auto \
  --cases core --repeats 1 --out /tmp/miru-copilot-core-routing-fixed-2026-10-27
bun run scripts/copilot-eval.ts --run --yes --model auto --allow-auto \
  --cases delegation,auth-failure,server-failure --repeats 1 \
  --out /tmp/miru-copilot-recovery-routing-fixed-2026-10-27
```

These output paths already exist; use new paths to repeat. Local evidence:

- Baseline core: `/tmp/miru-copilot-core-2026-10-27-exploratory`
- Baseline delegation/failures: `/tmp/miru-copilot-recovery-2026-10-27-exploratory`
- Updated core: `/tmp/miru-copilot-core-routing-fixed-2026-10-27`
- Updated delegation/failures: `/tmp/miru-copilot-recovery-routing-fixed-2026-10-27`
- Named-agent smoke: `/tmp/miru-copilot-routing-smoke-v1-2026-10-27`

All four main batches have corpus SHA-256
`694171d175552e4de2013f54e2f3080e7e9b9d953f6116d8865a096a8206bf26`.
Both updated batches and the post-run checkout match runtime SHA-256
`0f2ca330135cfb3c83c205e44bc21135f2d52a46165fe179866b39f6003d37ef`.
The historical runtime hash is
`abaa7acdb6c5cdf65ce1341918249a747d5a8231cc0d2fb6d422b37745b3715f`;
that older hash did not include agent Markdown templates.

Validation: 99 tests across the evaluation, agents, installer, policy, MCP schema,
runtime, legacy-hook and definition-size suites passed. Type checking and Biome
checks passed. No package was published; the evaluation runs local source.

The installed local Copilot instructions, profile and MCP visibility settings
were updated after evaluation. The existing server command, benchmark flag and
other MCP entries were preserved. Original files are backed up in
`~/.copilot/miru-backups/routing-1793114168276`. Restart Copilot to load these
files; start `copilot --agent=miru-code` for the restricted investigation profile.
