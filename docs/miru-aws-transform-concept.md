# Concept Sketch: Miru as an AWS Transform Modernization Agent

**Status:** Concept only - not a spec, not a commitment. Companion to the formal spec (`miru-aws-transform-kiro-power-spec.md`) and the research synopsis (`kiro-transform-research-synopsis.md`).

---

## The idea, in one line

Package Miru's existing search capability as a custom agent, built with AWS Transform's Agent Builder Toolkit, so that modernization teams working in AWS Transform get fast, semantic understanding of the legacy codebase they're migrating - without leaving the workflow they're already in.

---

## The problem this addresses

AWS Transform's whole premise is compressing multi-year modernization programs (mainframe, VMware, Windows/.NET) into months. The single biggest hidden cost in any of those programs is almost never the migration mechanics - it's the weeks or months spent by engineers just figuring out what a legacy codebase actually does, because the people who wrote it are long gone and the documentation, if it exists, is wrong. That's precisely the problem Miru already exists to solve, just not currently pointed at this specific audience or workflow.

---

## How it would work

At its simplest, this doesn't require building new search technology - it requires wrapping what Miru already does (`search`, `locate`, `expand`, `find_related`) behind an agent shaped for modernization-specific tasks, registered so AWS Transform users can discover and install it the same way they'd install any other Transform capability.

```
Modernization engineer, inside Kiro or the AWS Transform web console
        |
        v
AWS Transform job (e.g. "assess this mainframe codebase for migration")
        |
        v
Miru-powered agent, invoked as part of the assessment/planning phase
        |
        v
Miru MCP tools search the actual legacy codebase
   - "where is the batch settlement logic?"
   - "find everything related to this COBOL copybook"
   - "what calls this subroutine, and from where?"
        |
        v
Findings feed back into AWS Transform's assessment output -
dependency maps, complexity scoring, migration risk areas -
grounded in what the code actually does, not just static analysis
```

The mechanics of *how* code gets indexed don't change from what Miru already does today. What changes is the framing: instead of "help me code," the agent's steering/instructions would be shaped around "help me understand and assess this system for migration," and it would be discoverable from inside the tool modernization teams are already using.

---

## A concrete example workflow

1. A migration engineer opens an AWS Transform job for a legacy mainframe application.
2. As part of the assessment phase, they (or an orchestrating Transform agent) invoke the Miru-powered agent against the source repository.
3. The agent runs a structured pass - "map the major modules," "find all external interface points," "identify the most-referenced shared utilities" - using Miru's semantic search rather than keyword grep, which matters enormously in codebases full of cryptic mainframe naming conventions where keyword search alone is close to useless.
4. Results (module map, dependency graph, complexity hotspots) get attached to the AWS Transform job as assessment artifacts, informing the migration plan AWS Transform produces.
5. During the actual migration/rewrite phase, the same agent stays available for ad hoc questions - "what does this routine actually do before I port it?"

---

## Why this pairing makes sense beyond "it's technically possible"

- **The audience is already exactly who Miru's self-hosted mode was built for.** Legacy mainframe and enterprise systems undergoing modernization are disproportionately regulated, sensitive, or simply not something a customer will agree to send to a third-party API. The self-hosted SageMaker embedding path (already shipped) isn't a nice-to-have here - it's plausibly the only mode a real customer in this segment accepts. This should be the default configuration offered for this specific distribution channel, not an opt-in footnote.
- **It's a distribution channel Takara doesn't currently have.** Takara is already an AWS AI partner; AWS Transform's Agent Builder Toolkit explicitly names Migration and Modernization Competency Partners as its intended audience for custom agent building. This is a route to the modernization-buyer segment that doesn't exist today.
- **It reframes Miru's pitch away from the exact thing that's been under scrutiny.** The recent external feedback on Miru's benchmark claims was about "how many tokens does this save a general coding agent" - a claim that needs a rebuilt, rigorous harness to defend (see the separate engineering priority list). "Can an engineer understand an undocumented mainframe module in minutes instead of days" is a different, arguably easier claim to demonstrate credibly, and one this audience cares about more than token counts.

---

## What this deliberately doesn't try to be

- Not a new modernization product - Miru doesn't need to learn anything about COBOL, VMware, or .NET specifically. It's a general semantic search tool; the value here is applying it to a specific, high-value context, not rebuilding it.
- Not a replacement for AWS Transform's own migration logic - this sits alongside AWS Transform's existing assessment/planning agents as a capability they can call on, not a competing workflow.
- Not a decision to build yet - this is the concept the formal spec exists to pressure-test before any engineering time is committed.

---

*See `miru-aws-transform-kiro-power-spec.md` for the concrete requirements and open questions involved in actually building and registering this.*
