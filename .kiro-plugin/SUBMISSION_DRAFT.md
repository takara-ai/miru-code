# Kiro Power submission draft — not yet submitted

Draft copy for the submission form at `kiro.dev/powers/submit`. Fill in real name/email/org and submit manually — this file is not read by any code, it's a copy-paste source.

- **First / last name:** _(fill in — Takara submitter)_
- **Organization:** Takara
- **Email:** _(fill in — team contact, not a personal address)_
- **Use-case summary (3–4 words):** Semantic code search
- **GitHub repository URL:** https://github.com/takara-ai/miru-code
- **Domain / problem-space description (optional):**
  Miru adds repo-aware semantic code search to Kiro via MCP, replacing grep-style exploration with meaning-based search (`search`, `locate`, `expand`, `find_related`). Includes a modernization/assessment-focused skill for legacy-codebase dependency mapping and migration-readiness work.

## Pre-submission checklist (per kiro.dev/powers/submit requirements)

- [x] Power built using the Agent Plugins format (`$schema` present in both `.kiro-plugin/plugin.json` and `.kiro-plugin/mcp.json`)
- [x] Lives in a public GitHub repo (`takara-ai/miru-code`)
- [x] MCP server (`@takara-ai/miru-code`) is a published, non-beta npm package
- [x] `plugin.json` has required fields: `$schema`, `name`, `version`, `description`, `author.name`
- [ ] Privacy Policy link in repo docs — **not yet present, needed before submission**
- [ ] Support contact (email or link) in repo docs — **not yet present, needed before submission**
- [ ] Locally tested in Kiro (Powers panel → Add Custom Power → Import from folder) — **do this before submitting**

Two items are unmet: a Privacy Policy link and a support contact aren't currently documented anywhere in the repo. Add both (e.g. to the README or a new `PRIVACY.md`) before actually filling out the form.
