# Evaluate Miru with GitHub Copilot

The harness compares native Copilot, Copilot with Miru available, and the shipped
`miru-code` custom agent. It measures actual tool choices independently from
answer checks. It uses the **local Miru source checkout**, not the published npm
package, and does not change your normal MCP configuration.

## Setup

On macOS, install and sign in:

```sh
brew install --cask copilot-cli
copilot login --device-code
bun run scripts/copilot-eval.ts --doctor
```

`--doctor` checks the installed CLI flags without making model or embedding calls.
Login requires approval in your browser. Open `/model` in an interactive Copilot
session to see which models your account actually offers. Model names in help
text do not establish account access.

For the real backend, Miru needs its normal CLI credentials (`miru setup` or an
already configured embedding backend). Codex-plugin credentials are scoped to
that plugin and might not be available to this source checkout. The harness
never starts a real login from an evaluated agent: `auth` is intercepted, and
fault scenarios return controlled errors without changing credentials.

## Preview without usage

Run commands from the repository root. The default plan has 10 cases, 3 arms,
and 3 repeats: 90 fresh Copilot sessions.

```sh
bun run scripts/copilot-eval.ts --dry-run
bun run scripts/copilot-eval.ts --dry-run --cases all --repeats 1
bun test tests/copilot-eval.test.ts
```

The additional cases exercise delegation, authentication failure, and server
failure. Failure cases only apply to the Miru arms. Ground truth lives in the
harness and is never copied into the fixture repository.

## Start with a smoke test

For an account offering fixed models, replace `MODEL_ID` with one available to
your account:

```sh
bun run scripts/copilot-eval.ts --run --yes --model MODEL_ID \
  --cases literal --repeats 1 --out /tmp/miru-copilot-smoke
```

Copilot Free can offer only Auto. Use this explicitly labelled exploratory mode:

```sh
bun run scripts/copilot-eval.ts --run --yes --model auto --allow-auto \
  --cases literal --repeats 1 --out /tmp/miru-copilot-auto-smoke
```

Auto is useful for checking discovery and policy adherence. It can route different
runs to different models, so its results are **not a model-controlled comparison**.
Record the actual models when usage events expose them; otherwise they are unknown.

For wiring/debugging without embedding credentials, add `--backend fixture`.
This uses production MCP schemas, descriptions and formatting with deterministic
lexical chunk retrieval. Copilot calls still consume your plan usage. This mode
does **not** measure Miru semantic retrieval quality or real embedding latency.

## Run the comparison

After inspecting the smoke-test evidence:

```sh
bun run scripts/copilot-eval.ts --run --yes --model MODEL_ID \
  --cases core --repeats 3 --out /tmp/miru-copilot-core

bun run scripts/copilot-eval.ts --run --yes --model MODEL_ID \
  --cases delegation,auth-failure,server-failure --repeats 3 \
  --out /tmp/miru-copilot-recovery
```

Every output directory must be new. Use `--arms native,miru` to select arms,
`--cases conceptual,literal` for selected cases, `--seed 42` for reproducible
randomized order, and `--timeout 180` for a per-session deadline. Runs execute
sequentially and stop on the first setup, authentication, quota or timeout error.
Completed evidence is written after each session. Do not treat partial runs as a
balanced experiment.

The run requires both `--run` and `--yes` because it spends Copilot usage and,
with the real backend, embedding inference. There is no universal monetary cap
across Copilot plans; start with one case and one repeat.

## Evidence and scoring

Each report contains a manifest, `results.json`, `report.md`, and a directory per
run. Each run saves:

- `session.jsonl`: Copilot events, including tool choices and final answers.
- `otel.jsonl`: local OpenTelemetry export for independent inspection.
- `usage.json`: the CLI's original final usage statistics, when available.
- `mcp.jsonl`: Miru requests and responses, including simulated faults.
- `stderr.txt` and `logs/`: setup and runtime diagnostics.
- `before.json`, `after.json`, and `repo/`: source hashes and the resulting corpus.
- `run.json` and `result.json`: arguments, answer checks, and policy observations.
- `routing.json`: the exact installed Miru instructions, agent profile and MCP configuration (Miru arms).
- `guard.jsonl`: hook activity and denials, with no prompt or source text. Inspect
  this alongside tool completion events to separate blocked attempts from searches
  that actually ran.
- `routing-guard.js`: the exact bundled helper installed for that Miru session.

The Markdown report summarizes completed runs, answer checks, first-tool choices,
known usage, and latency by arm, followed by individual runs. Auto routing is
labelled exploratory in both the manifest and report. The manifest hashes the
corpus, TypeScript runtime sources and agent Markdown templates, and records the
Git revision and dirty paths.

The automated answer oracle requires expected paths and fact alternatives in the
final answer. It is a **smoke check**, not semantic grading: paraphrases can fail,
and an incorrect answer can still contain the required words. Review raw answers
before claiming accuracy. Delegation is scored separately; a correct answer
without delegation does not establish subagent compliance.

Tool names, call arguments, failures, first-tool correctness, native search before
Miru, repeated searches, broad-read candidates, speculative auth, write attempts,
and actual source changes are recorded independently. Missing usage is `null`,
never zero. Final CLI model metrics are preferred over session usage events and
include child agents; their per-agent/provider breakdowns are not added again.
Input is the provider's total input counter; cache reads/writes are reported
separately, not added to it. Do not add reasoning tokens to output tokens.

`billing` saves the CLI's session-wide `totalNanoAiu` only when
`aiCreditsStatus` is complete. The credit table includes every measured attempt,
including known-cost failures and incorrect answers. Missing or pending cost is
unknown, never zero. Convert nano-AI units to AI credits by dividing by `1e9`;
compare recorded credits instead of pricing every input token as fresh input.
These counters exclude Miru embedding, indexing and hosting costs and are not an
invoice reconciliation. Check actual routed models before attributing savings
to the integration.

The first-tool score continues to count attempted choices, including rejected
tools. `firstExecutedToolCorrect` and `nativeSearchExecuted` separately describe
successful tool completions. `contextViolationAttempts` and
`contextViolationsExecuted` replay the bounded-read policy against the trace.
The range parser handles chunk headers, inline locate hits and grouped file
headers with numbered matches. `repositoryScopeRejections` records invalid
repository requests separately from index or credential failures, including
rejections that the agent corrects before answering.
For the two fixtures whose numeric returns have no declared units,
`unsupportedUnitCandidates` flags unit assertions for human review; it does not
change the historical path/fact answer check or provide a general semantic judge.

Rescore existing evidence without model or embedding calls:

```sh
bun run scripts/copilot-eval.ts --rescore /tmp/miru-copilot-core
```

## Controls and limits

- The normal Miru arm uses the production installer instructions and named
  `miru-code` profile, while keeping normal native tools available. The agent arm
  selects that profile: it deliberately exposes only named Miru tools, reads and
  named-agent delegation. This is a product capability restriction, not evidence
  of voluntary avoidance of native search. The native arm receives neither the
  Miru instructions nor the profile. The user prompts are unchanged across arms.
- The current Copilot instructions installation also installs CLI hooks in a
  separate owned `hooks/miru-routing.json` file and a bundled helper in
  `miru-routing/`. They redirect native searches that overlap indexable files,
  prevent built-in code-search delegation and directory-listing discovery, and
  require located, bounded source reads before expansion at an already read
  anchor. Scope uses Miru's file walker, ignore rules and file
  size filter; ignored and external paths remain available. Post-tool guidance
  reminds the model to ground units in the returned evidence. This is an explicit
  product control, not evidence that the model voluntarily avoids native tools.
- Hooks run only when their configured Miru MCP entry is enabled. They make no
  model or embedding calls. Missing configuration or runtime errors fall back to
  ordinary Copilot permissions; disabled hooks and hook timeouts can also bypass
  this routing helper. It is not a security boundary. Per-session context state
  is private, bounded and isolated between agents; it is removed at session end
  or expires after a day. Other user hook files are preserved.
- Private per-run `COPILOT_HOME` directories copy only authentication references.
  They are removed after each session. Personal Copilot instructions, plugins,
  saved permissions and MCP servers are not copied. The `HOME` variable is unchanged.
- Personal `~/.agents` skill descriptions may still be advertised by Copilot.
  Skill invocation is excluded equally across arms; inspect raw traces for drift.
- Source writes, shell execution and web tools are denied in all arms. Attempted
  mutations remain observable. This is a read-only behavior test, not proof of
  safety with unrestricted permissions. Source comments include one inert
  instruction-injection canary.
- The MCP wrapper restricts `repo` to the fixture root and blocks real `auth`
  side effects. Auth/server faults are simulations, not real credential failures.
- Every fixture path is fresh. Time includes cold index setup where required;
  these results do not establish warm-cache latency or performance on large repos.
- Current installer defaults are exercised: Miru uses `deferTools: "never"`,
  installs a marked global Copilot policy, and provides a named specialist with
  explicit tools and `include-custom-instructions: true`. The policy directs code
  delegation through `task` to `miru-code`, rather than `search_code_subagent`.
  The latter may run a native-only search child. Historical baseline reports
  predate these defaults; keep their manifests and traces when comparing results.
- Copilot identifies itself during MCP initialization. Miru sends it compact
  instructions and tool descriptions with the same tools and schemas. Search
  and related-code results include complete chunks up to 12 lines and 2,000
  characters; longer chunks retain bounded excerpts. The installed Copilot
  policy requests initial context for behavior lookups and avoids unnecessary
  delegation. These optimizations apply to normal Copilot, without selecting
  the specialist profile. Initialization metadata in `mcp.jsonl` records which
  client connected.
- `result.json` separates child Miru calls, child native searches and built-in
  search delegation. A parent answer or parent Miru call alone does not establish
  that a delegated child used Miru.
- Reports are created with a private parent directory. Authentication homes are
  temporary; raw traces should still be reviewed before sharing.

The hook formats and lifecycle behavior follow the
[GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).
Older result directories predate these hooks; retain their original evidence
and distinguish their policy from the current configuration.

After the CLI evaluation, replay representative prompts in the actual VS Code
harness. Confirm Miru's tool calls in that session; CLI success alone does not
verify VS Code configuration.

References: [Copilot CLI installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli),
[CLI flags and OpenTelemetry](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[session event schemas](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events).
