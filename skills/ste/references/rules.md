# STE rules catalog (Miru paraphrase)

Unofficial structural catalog for Miru STE **strict** / audit use.
Themes follow ASD-STE100 Issue 9. **Not a copy of the official standard. Not a dictionary.**
Official standard and dictionary: https://www.asd-ste100.org

Cite the rule IDs below only. Do not invent other ASD numbers.

## Words and terms

### R1 — One name per concept
Pick one term for each idea in the document. Do not rotate synonyms (`check` / `verify` / `validate`) for the same action.

### R2 — Approved instruction modals
In procedures, prefer `can`, `will`, `must`. Avoid `should`, `would`, `may`, `might`, `could` when you give an instruction.

### R3 — Keep articles and "that"
Write complete noun phrases. Keep `a`, `an`, `the`, and `that`. Do not drop them for brevity.

### R4 — No semicolon glue
Do not join two ideas with a semicolon. Use two sentences.

## Sentences

### R5 — Procedural length
In procedures, aim for about **20 words or fewer** per sentence. Give **one instruction** per sentence.

### R6 — Descriptive length
In descriptions, aim for about **25 words or fewer** per sentence. Keep **one topic** per paragraph.

### R7 — Condition before command
State the condition first. Then give the command.

Example: `If the node is down, stop the job.`
Not: `Stop the job if the node is down.` when the condition is the safety gate.

### R8 — Active voice and simple tense
Prefer active voice and simple present or simple past. Avoid stacked present-perfect and trailing "-ing" clauses that hide the actor.

## Safety

### R9 — Warning shape
For destructive actions: state the command or the condition clearly, then state the risk.

Example: `Do not run this on production. This command deletes all rows in the table.`

### R10 — Do not drop required limits
If a version, limit, or condition is required for safety, keep it. Clarity beats compression.

## Software examples

| Weak | Stronger STE shape |
|------|--------------------|
| You might want to restart the pod | Restart the pod |
| Ensure that connectivity has been established | Make sure the connection is up |
| After having deployed the chart, proceed to verify | Deploy the chart. Then check the release status |

## Dictionary

Miru does **not** ship the ASD approved-word list. For strict vocabulary compliance, use the official dictionary from asd-ste100.org. Domain technical nouns (`Kubernetes`, `webhook`, `IAM`) stay as product names (untouchable).
