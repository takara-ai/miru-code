# Miru as an AWS Transform Kiro Power - Specification

**Status:** Draft for review - first pass, not yet discussed with stakeholders
**Owner:** Paul Melvin
**Component/Area:** Miru - AWS Transform / Kiro Power distribution
**Related:** Concept sketch (`miru-aws-transform-concept.md`); research synopsis (`kiro-transform-research-synopsis.md`); DS1 self-hosted container licensing spec (the self-hosted SageMaker embedding path this spec leans on already exists as of Miru v1.5.0)
**Template version:** Takara Feature Spec Template v1

---

## 1. Purpose

Register a Miru-powered custom agent with AWS Transform's Agent Builder Toolkit, so that migration and modernization teams using AWS Transform (via Kiro, the web console, or programmatically) can discover and use Miru's semantic code search as part of their modernization workflow - reaching a customer segment Takara does not currently have a distribution channel into, via a partner program Takara is already part of (AWS AI Partner).

This is a first-pass spec. Unlike the other specs in this set, this one has not yet been through a stakeholder Q&A round - several sections below flag assumptions rather than settled decisions, and §8 is longer than usual as a result.

---

## 2. Decisions already made - please don't reopen these

- None yet locked. This spec has not been reviewed with stakeholders. Treat every substantive choice below as a proposal, not a decision, until reviewed.

---

## 3. Scope

### In scope
- Packaging Miru's existing MCP tools (`search`, `locate`, `expand`, `find_related`) behind a custom agent built with AWS Transform's Agent Builder Toolkit.
- Modernization-specific steering/framing for that agent (assessment and dependency-mapping oriented instructions, distinct from Miru's general-purpose coding-assistant framing).
- Registering the resulting agent for discovery within the AWS Transform / Kiro Power marketplace.
- Defaulting this specific distribution channel to the self-hosted SageMaker embedding path (already shipped in Miru v1.5.0) rather than Takara-hosted DS1, given the sensitivity profile of this audience.

### Out of scope (for this phase)
- Any new modernization-specific intelligence (COBOL parsing, VMware-specific analysis, etc.) - this wraps Miru's existing general-purpose search, it does not extend it.
- Deep integration with AWS Transform's own assessment/planning agent internals beyond what the Agent Builder Toolkit's standard integration surface provides.
- Any change to Miru's core product for non-Transform users - this is a packaging and distribution exercise, not a product change.

---

## 4. Functional requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| MAT-1 | The agent exposes Miru's existing `search`, `locate`, `expand`, and `find_related` MCP tools without modification to their underlying behaviour. | Required |
| MAT-2 | The agent's steering/instructions are written for a modernization-assessment use case (e.g. "map dependencies," "identify high-risk or high-complexity modules," "find all callers of this routine") rather than Miru's default general-purpose coding-assistant framing. | Required |
| MAT-3 | The agent's default, documented configuration for this distribution channel uses the self-hosted SageMaker embedding backend, not Takara-hosted DS1 - given the sensitivity profile of legacy/regulated systems typical of this audience. Takara-hosted mode remains available but is not the default presented in onboarding for this specific channel. | Required |
| MAT-4 | The agent can be pointed at a codebase already connected to an AWS Transform job (via whatever mechanism AWS Transform Connectors expose) without requiring a separate, manual repository setup step, if the Agent Builder Toolkit's integration surface supports this. **Open question - see §8.** | Recommended |
| MAT-5 | Findings produced during a Miru-assisted assessment (e.g. a dependency map or complexity summary) can be attached to or referenced from the AWS Transform job as an artifact, if the toolkit supports agents contributing structured output back to a job. **Open question - see §8.** | Recommended |

---

## 5. Dependent / external system requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| MAT-E1 | The agent must be built using AWS Transform's Agent Builder Toolkit (GA as of May 2026), available via the Kiro power marketplace. | Required |
| MAT-E2 | Registering the agent for discovery requires whatever validation AWS applies to Migration and Modernization Competency Partners submitting custom agents - exact process not yet confirmed directly with AWS (see §8). | Required |
| MAT-E3 | The agent must be compatible with the AWS Transform MCP server's expected integration contract (human-in-the-loop forms, status updates, job orchestration) as documented by AWS at the time of building - not assumed stable from this spec's research alone, given how recently (May 2026) this toolkit reached GA. | Required |

---

## 6. Interface / data design

| ID | Requirement | Priority |
|----|-------------|----------|
| MAT-C1 | Agent manifest/listing metadata (name, description, capability summary) should clearly state the self-hosted-by-default configuration and the audience it's built for, consistent with the "lead with the SageMaker path" positioning already recommended for Miru generally. | Required |
| MAT-C2 | No new credential type is introduced by this work - the agent uses Miru's existing credential/auth mechanisms (Takara token or SageMaker AWS credentials, per MAT-3) unchanged. | Required |

---

## 7. Non-functional requirements

- **Security and positioning:** given the likely sensitivity of codebases in modernization programs (mainframe, legacy enterprise systems, often regulated industries), this channel should be held to at least the same security-communication bar as the rest of Miru's self-hosted story - clear, upfront, not buried (the exact criticism raised in the recent external feedback about the SageMaker docs being under-surfaced in the main README applies with extra force to this specific, more security-conscious audience).
- **Maintenance burden:** an AWS Transform-specific agent is another surface to keep in sync with Miru's core MCP tool behaviour as it evolves - worth a lightweight owner/process decision (§8) so it doesn't quietly drift out of date the way generic multi-IDE support can be harder to notice breaking.

---

## 8. Open questions for engineering (and partnerships)

1. **Exact partner validation/registration process** - what AWS actually requires to get a custom agent listed and discoverable via the Kiro power marketplace for AWS Transform. Needs direct confirmation with AWS, likely through Takara's existing AWS AI Partner relationship, rather than inferred from public documentation.
2. **Agent Builder Toolkit's actual integration surface** - whether it supports agents reading from AWS Transform Connectors directly (MAT-4) and contributing structured artifacts back to a job (MAT-5), or whether those are done through a more manual/separate mechanism. The toolkit reached GA very recently (May 2026); this spec's research reflects what's publicly documented, not hands-on testing.
3. **Ownership** - who maintains this integration once built, and what triggers a review (a Miru MCP tool change, an AWS Transform toolkit change, or both).
4. **Naming and branding** - what this agent is actually called in the marketplace, and whether it's positioned as "Miru for modernization" or under different branding suited to the AWS Transform audience.
5. **Commercial model** - whether this is a free/promotional distribution channel to build awareness, or tied to Miru's existing or planned commercial terms. Not addressed in this spec; likely a commercial/product decision, consistent with how commercial questions have been scoped out of engineering specs elsewhere in this body of work.
6. **Timing relative to the benchmark rework** - whether it's worth sequencing this after the benchmark methodology work already prioritized, so that any efficacy claims made to this new, more technically sophisticated audience are made on solid footing from the start, rather than risk repeating the credibility problem raised by the recent external review.

---

## 9. Suggested acceptance criteria

- [ ] A working custom agent, built with the Agent Builder Toolkit, exposes Miru's four core search tools inside an AWS Transform context.
- [ ] The agent's default onboarding path configures the self-hosted SageMaker embedding backend, not Takara-hosted DS1.
- [ ] The agent is discoverable in the Kiro power marketplace under an AWS Transform-relevant listing.
- [ ] A real modernization-style query (e.g. "map dependencies for this module") against a representative legacy codebase produces a materially more useful result than the equivalent AWS Transform workflow without Miru - this needs a concrete before/after example, not just a capability checklist, before this is presented externally.

---

*This is a first-pass spec, not yet reviewed. Every item in §8 should be resolved, and this document revised, before any implementation work begins.*
