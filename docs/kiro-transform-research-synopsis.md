# Miru, Kiro, and AWS Transform - Research Synopsis

**Prepared by:** Paul Melvin (with research assistance)
**Purpose:** Summarize findings on how well Miru integrates with AWS Kiro, and the opportunity presented by AWS Transform, for internal sharing.

---

## TL;DR

- **Miru already integrates cleanly with Kiro today** - verified directly against the current Miru source code and Kiro's own documentation. No work needed here.
- **AWS Transform is AWS's agentic enterprise modernization platform** (mainframe, VMware, Windows/.NET migration), and it recently opened a real door for partners: the **AWS Transform Agent Builder Toolkit**, a Kiro Power that lets AWS partners build and register custom agents for discovery inside AWS Transform.
- **This is a genuine opportunity, not just a compatibility check.** Takara is already an AWS AI Partner; AWS explicitly names Migration and Modernization Competency Partners as the audience for this toolkit. Modernization work - making sense of large, unfamiliar, undocumented legacy codebases - is close to the exact problem Miru is built to solve.
- **The audience this reaches is disproportionately security-conscious** (regulated industries, legacy enterprise systems), which lines up well with Miru's self-hosted SageMaker embedding mode, already shipped, but currently under-promoted in Miru's own documentation.
- Two companion documents exist alongside this one: a concept sketch of what a Miru-powered AWS Transform agent could look like, and a formal first-pass spec for pursuing it.

---

## What is Kiro?

Kiro (kiro.dev) is AWS's own AI-powered IDE, built on a familiar VS Code-like editor experience, with native Model Context Protocol (MCP) support, spec-driven development workflows, "steering files" (plain-markdown behavior instructions), hooks, and subagents. It supports multiple sign-in options (GitHub, Google, AWS Builder ID, IAM Identity Center, external identity providers) and is available in AWS GovCloud regions for elevated-compliance workloads.

**Kiro Powers** are AWS's curated marketplace of pre-packaged MCP servers, steering files, and hooks, validated by Kiro partners, installable in one click from inside Kiro or from a public marketplace page. Examples already live: an AWS Observability power (bundling CloudWatch, Application Signals, CloudTrail, and AWS Documentation MCP servers) and, most relevantly, the AWS Transform Agent Builder Toolkit power described below.

## How does Miru integrate with Kiro today?

Verified directly against Miru's current installer source code and cross-checked against Kiro's own current documentation - every integration point matches exactly:

| Integration point | Path / mechanism |
|---|---|
| MCP server config | `~/.kiro/settings/mcp.json` (`mcpServers` key) |
| Steering / instructions | `~/.kiro/steering/miru.md` |
| Search-hook interception | `~/.kiro/settings/hooks.json` |
| Subagent registration | `~/.kiro/agents/miru-code.md` |
| Native skill directories (Caveman, STE) | Kiro-native paths - one of only two supported IDEs (with Claude Code) that get this treatment rather than the shared cross-agent skills path |

This is a deeper integration than most of Miru's other supported IDEs receive. No changes are needed for Miru to work well inside plain Kiro today.

## What is AWS Transform?

AWS Transform is described by AWS as a collaborative enterprise IT transformation workbench, powered by expert agents, that accelerates cloud migration, application modernization, and continuous technical-debt reduction - covering scenarios like mainframe, VMware, and Windows/.NET modernization. It's accessible three ways, with consistent state across all of them: through a Kiro Power, through agent plugins for other IDEs (Claude, Cursor, Codex), and through a dedicated AWS Transform MCP server directly.

Supporting infrastructure includes **AWS Transform Connectors** (secure cross-account access to source systems, with IAM role assumption, KMS encryption, and CloudTrail-audited access) and a **customer-owned AWS Transform Artifact Store** (the customer's own S3 bucket) - both signal that this product is built for security-conscious enterprise buyers.

## The specific opportunity: Agent Builder Toolkit

On May 14, 2026, AWS announced general availability of the **AWS Transform Agent Builder Toolkit** as a Kiro Power. This lets AWS partners and customers build agents tailored to their own modernization needs, share them across teams or partner networks, and **register them with AWS Transform for discovery** in the marketplace. AWS explicitly names Migration and Modernization Competency Partners, ISVs, and enterprise customers encoding their own standards as the intended users.

This is the mechanism that makes "a Miru-powered modernization agent, discoverable by AWS Transform customers" a real, buildable thing - not a hypothetical integration.

## Why this pairing makes sense

Modernization programs are dominated by the cost of understanding legacy systems well enough to migrate them safely - exactly the problem semantic code search exists to help with, and arguably a more compelling, easier-to-demonstrate use case than Miru's general "saves tokens for a coding agent" pitch, which has recently come under credible external scrutiny over how that claim is measured (see the separate benchmark-methodology review). "Help an engineer understand an undocumented mainframe module in minutes" is a different, more visceral, and more defensible claim for this specific audience.

## What to check before committing further

- The exact partner validation process for getting an agent listed in the marketplace is not fully documented publicly - worth a direct conversation with AWS, likely through Takara's existing AWS AI Partner relationship.
- The Agent Builder Toolkit reached general availability very recently (May 2026); its integration surface (whether agents can read AWS Transform Connectors directly, or contribute structured findings back to a job) should be confirmed hands-on rather than assumed from documentation alone.

---

## Sources

- [Kiro official site](https://kiro.dev)
- [AWS Transform official site](https://aws.amazon.com/transform/)
- [Kiro MCP documentation (kiro.dev)](https://kiro.dev/docs/mcp/)
- [AWS Transform introduces the Agent Builder Toolkit Kiro Power (AWS "What's New," May 14, 2026)](https://aws.amazon.com/about-aws/whats-new/2026/05/aws-transform-agent-builder-toolkit/)
- [AWS Transform agents now available in Kiro, Claude, Cursor, and Codex (AWS "What's New," May 14, 2026)](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-transform-developer-tools/)
- [Simplify how you build and publish Custom Agents with AWS Transform Agent Builder Toolkit (AWS Migration & Modernization Blog)](https://aws.amazon.com/blogs/migration-and-modernization/simplify-how-you-build-and-publish-custom-agents-with-aws-transform-agent-builder-toolkit/)
- [AWS Transform is now available in Kiro and VS Code (AWS "What's New," April 14, 2026)](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-transform-kiro-vscode/)
- [AWS Observability now available as a Kiro power (AWS "What's New," Feb 24, 2026) - example of an existing, comparable Kiro Power](https://aws.amazon.com/about-aws/whats-new/2026/02/aws-observability-kiro-power/)
- [Kiro is now available in AWS GovCloud (US) Regions (AWS "What's New," Feb 16, 2026)](https://aws.amazon.com/about-aws/whats-new/2026/02/kiro-launch-aws-govcloud-us)
- [Agentic Cloud Modernization: Accelerating Modernization with AWS MCPs and Kiro (AWS Migration & Modernization Blog)](https://aws.amazon.com/blogs/migration-and-modernization/agentic-cloud-modernization-accelerating-modernization-with-aws-mcps-and-kiro/)
- [Getting Started with Kiro and MCP Servers (AWS re:Post)](https://repost.aws/articles/ARuX8rkojgSx-TYCc65JyAOw/getting-started-with-kiro-and-mcp-servers-connect-your-ai-ide-to-real-world-tools)
- [The AWS MCP Server is now generally available (AWS Blog)](https://aws.amazon.com/blogs/aws/the-aws-mcp-server-is-now-generally-available/)
- [Kiro Powers for autonomous AI agents on AWS (PwC)](https://www.pwc.com/us/en/technology/alliances/library/kiro-powers-autonomous-ai-agents-aws.html) - useful background on how Kiro Powers work architecturally

---

*Companion documents: `miru-aws-transform-concept.md` (concept sketch), `miru-aws-transform-kiro-power-spec.md` (first-pass formal spec).*
