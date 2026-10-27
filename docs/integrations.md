# Agent integrations

[Quick start](../README.md#install) · [Reference](reference.md)

## Plugin marketplaces

### Claude Code

Use the [plugin quick start](../README.md#claude-code-recommended). The plugin includes MCP tools, search and writing skills, and the `miru:miru-code` sub-agent.

- Update: `/plugin marketplace update miru`, then reinstall.
- Remove: `/plugin uninstall miru`.
- Settings: use `/plugin` to configure benchmark mode or a [SageMaker endpoint](self-hosted-sagemaker.md#claude-code-plugin).

### Codex

The repository provides a [Codex plugin](../.codex-plugin/plugin.json) and [marketplace manifest](../.agents/plugins/marketplace.json). The plugin includes MCP tools and skills.

To use self-hosted embeddings, ask Miru to configure your SageMaker endpoint ARN and existing AWS profile. The `auth` tool validates the endpoint and saves it in the plugin's data directory. See [Codex SageMaker setup](self-hosted-sagemaker.md#codex-plugin).

### Cursor

1. Dashboard → Plugins → Team Marketplaces → **Add Marketplace** → Import from Repo → `takara-ai/miru-code`.
2. Customize → find **miru** → **Install** → choose project or user scope.

The plugin provides skills and rules. Connect the MCP search tools through the [CLI installer](../README.md#install-cli-fallback).

### Capabilities

| Capability | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| MCP search tools | Included | Included | CLI installer |
| Miru, Caveman, and STE skills | Included | Included | Included |
| Dedicated sub-agent | Included | — | — |
| Benchmark setting in plugin UI | Included | — | — |
| SageMaker configuration | Plugin settings | `auth` tool | CLI setup |

Claude Code and Codex store credentials in separate plugin data directories. These survive plugin updates and are separate from CLI credentials; authenticate in each installation you use.

## CLI integrations

Run `miru install` to choose agents and integrations. Use **↑↓** to move, **space** to toggle, **a** to select all, and **enter** to confirm.

The installer configures MCP, instructions, sub-agents, and optional skills where supported. It also removes stale Miru search hooks. Restart your agents after installation.

| IDE            | MCP                                   | Instructions / rules            | Caveman *(experimental)*            | STE *(experimental)*                    |
| -------------- | ------------------------------------- | ------------------------------- | ----------------------------------- | --------------------------------------- |
| Cursor         | `~/.cursor/mcp.json`                  | `~/.cursor/rules/miru-code.mdc` | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| Claude Code    | `~/.claude.json`                      | `~/.claude/CLAUDE.md`           | `~/.claude/skills/caveman/SKILL.md` | `~/.claude/skills/ste/SKILL.md`         |
| Gemini CLI     | `~/.gemini/settings.json`             | `~/.gemini/GEMINI.md`           | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| Kiro           | `~/.kiro/settings/mcp.json`           | `~/.kiro/steering/miru.md`      | `~/.kiro/skills/caveman/SKILL.md`   | `~/.kiro/skills/ste/SKILL.md`           |
| OpenCode       | `$XDG_CONFIG_HOME/opencode/opencode.json(c)` *(else `~/.config/opencode/…`)* | `…/AGENTS.md` | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md` |
| GitHub Copilot | `~/.copilot/mcp-config.json`          | `~/.copilot/copilot-instructions.md` | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| Codex          | `~/.codex/config.toml`                | `~/.codex/AGENTS.md`            | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| VS Code        | `…/Code/User/mcp.json`                | —                               | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| Visual Studio  | `%USERPROFILE%\.mcp.json`             | —                               | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |
| Windsurf       | —                                     | —                               | `~/.agents/skills/caveman/SKILL.md` | `~/.agents/skills/ste/SKILL.md`         |

Windsurf / Devin Desktop integration is experimental and has no MCP entry.

### GitHub Copilot CLI

In `miru install`, enable **MCP server**, **Instructions**, and **Sub-agent** for GitHub Copilot, then restart Copilot.

Copilot CLI's instructions integration also installs `~/.copilot/hooks/miru-routing.json`
and a bundled helper in `~/.copilot/miru-routing/`. It redirects indexed native
searches to Miru and checks context-read ranges. Other user hook files are
preserved. See the [repeated Copilot evaluation](copilot-routing-repeat-evaluation.md)
for measured behavior and limits.

Normal Copilot receives compact Miru instructions and tool definitions. Small
search results include complete chunks to avoid a second context call; larger
results retain bounded snippets. Routine lookups stay in the main agent, while
explicit delegation still uses `miru-code`. These defaults do not require
selecting a custom agent. The MCP server detects Copilot's client name during
initialization; other clients keep their existing definitions.
See the [normal Copilot cost evaluation](copilot-cost-evaluation.md) for measured
costs and remaining overhead.

## Optional skills

- **Caveman:** compresses chat replies. Invoke with `/caveman lite|full|ultra`; stop with “normal mode”. Commits, PRs, and customer documents retain normal prose.
- **STE:** clear technical writing for docs, runbooks, errors, and release notes. Invoke with `/ste` or “de-slop this”. It uses ASD-STE100-inspired guidance and is not ASD-certified.

Both are off by default in the CLI installer. Invocation syntax varies by agent. Most agents share `~/.agents/skills/`; Claude Code and Kiro use their native skill directories. Shared-path ownership is tracked in `miru-owners.json`, so uninstalling one agent keeps skills still used by another.

For a project-local sub-agent that you can commit:

```bash
miru init --agent claude --force
```

## Plugin development

| Host | Manifests |
| --- | --- |
| Claude Code | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.claude-plugin/mcp.json` |
| Codex | `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, root `mcp.json` |
| Cursor | Root `plugin.json`, `.cursor/rules/miru-code-search.mdc` |

The MCP plugin manifests launch the published runtime with `bunx @takara-ai/miru-code@latest mcp`. Local source changes require a package release to reach installed plugins. For development, point an MCP client at:

```json
{
  "miru": {
    "command": "bun",
    "args": ["/path/to/miru-code/src/cli.ts", "mcp"]
  }
}
```

This repository's [Codex configuration](../.codex/config.toml) approves Miru search tools and benchmark rollups while prompting for authentication. It applies to trusted checkouts using `miru@personal`; other marketplace identities need a matching configuration.
