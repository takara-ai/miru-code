package installer

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	miru "github.com/takara-ai/miru-code"
)

type Mode string

const (
	Install   Mode = "install"
	Uninstall Mode = "uninstall"
)

type MCPConfig struct {
	Path      string
	Key       string
	MemberKey string
	Entry     map[string]any
	Format    string
}

type AgentTarget struct {
	ID               string
	DisplayName      string
	ConfigDir        string
	MCP              *MCPConfig
	InstructionsPath string
	SubagentPath     string
	SubagentID       miru.AgentID
}

type WriteResult struct {
	Path   string
	Action Action
	Kind   string
	Agent  string
}

var instructions = MiruStart + `
## Miru Code Search

A ` + "`miru`" + ` MCP server is available with two tools:
- ` + "`search`" + ` - search the codebase with a natural-language or code query.
- ` + "`find_related`" + ` - find code similar to a specific file and line.

Always call ` + "`search`" + ` before using Grep, Glob, or Read to explore the codebase.

Set ` + "`TAKARA_API_KEY`" + ` in your MCP config, or run ` + "`miru setup`" + ` for CLI use.

` + MiruEnd + "\n"

func AgentTargets() []AgentTarget {
	home := homeDir()
	return []AgentTarget{
		{
			ID: "claude", DisplayName: "Claude Code", ConfigDir: filepath.Join(home, ".claude"),
			MCP:              jsonMCP(filepath.Join(home, ".claude.json"), "mcpServers", stdioConfig(true)),
			InstructionsPath: filepath.Join(home, ".claude", "CLAUDE.md"),
			SubagentPath:     filepath.Join(home, ".claude", "agents", "miru-code.md"),
			SubagentID:       miru.AgentClaude,
		},
		{
			ID: "cursor", DisplayName: "Cursor", ConfigDir: filepath.Join(home, ".cursor"),
			MCP:          jsonMCP(filepath.Join(home, ".cursor", "mcp.json"), "mcpServers", stdioConfig(true)),
			SubagentPath: filepath.Join(home, ".cursor", "agents", "miru-code.md"),
			SubagentID:   miru.AgentCursor,
		},
		{
			ID: "gemini", DisplayName: "Gemini CLI", ConfigDir: filepath.Join(home, ".gemini"),
			MCP:              jsonMCP(filepath.Join(home, ".gemini", "settings.json"), "mcpServers", stdioConfig(true)),
			InstructionsPath: filepath.Join(home, ".gemini", "GEMINI.md"),
			SubagentPath:     filepath.Join(home, ".gemini", "agents", "miru-code.md"),
			SubagentID:       miru.AgentGemini,
		},
		{
			ID: "kiro", DisplayName: "Kiro", ConfigDir: filepath.Join(home, ".kiro"),
			MCP:              jsonMCP(filepath.Join(home, ".kiro", "settings", "mcp.json"), "mcpServers", stdioConfig(true)),
			InstructionsPath: filepath.Join(home, ".kiro", "steering", "miru.md"),
			SubagentPath:     filepath.Join(home, ".kiro", "agents", "miru-code.md"),
			SubagentID:       miru.AgentKiro,
		},
		{
			ID: "opencode", DisplayName: "OpenCode", ConfigDir: filepath.Join(home, ".config", "opencode"),
			MCP: jsonMCP(opencodeMCPPath(home), "mcp", map[string]any{
				"command": []any{"miru"}, "type": "local", "enabled": true,
				"environment": map[string]any{"TAKARA_API_KEY": "${TAKARA_API_KEY}"},
			}),
			InstructionsPath: filepath.Join(home, ".config", "opencode", "AGENTS.md"),
			SubagentPath:     filepath.Join(home, ".config", "opencode", "agents", "miru-code.md"),
			SubagentID:       miru.AgentOpenCode,
		},
		{
			ID: "copilot", DisplayName: "GitHub Copilot", ConfigDir: filepath.Join(home, ".config", "github-copilot"),
			MCP:          jsonMCP(filepath.Join(home, ".copilot", "mcp-config.json"), "mcpServers", stdioConfig(false)),
			SubagentPath: filepath.Join(home, ".copilot", "agents", "miru-code.agent.md"),
			SubagentID:   miru.AgentCopilot,
		},
		{
			ID: "codex", DisplayName: "Codex", ConfigDir: filepath.Join(home, ".codex"),
			MCP:              &MCPConfig{Path: filepath.Join(home, ".codex", "config.toml"), Key: "mcp_servers", MemberKey: "miru", Format: "toml"},
			InstructionsPath: filepath.Join(home, ".codex", "AGENTS.md"),
		},
		{
			ID: "vscode", DisplayName: "VS Code",
			MCP: jsonMCP(vscodeMCPPath(home), "servers", stdioConfig(true)),
		},
	}
}

func Run(mode Mode) ([]WriteResult, error) {
	results := []WriteResult{}
	for _, agent := range AgentTargets() {
		if result := ApplyMCP(agent, mode); result != nil {
			results = append(results, *result)
		}
		if result := ApplyInstructions(agent, mode); result != nil {
			results = append(results, *result)
		}
		if result := ApplySubagent(agent, mode); result != nil {
			results = append(results, *result)
		}
	}
	return results, nil
}

func ApplyMCP(agent AgentTarget, mode Mode) *WriteResult {
	if agent.MCP == nil {
		return nil
	}
	action := ActionError
	if agent.MCP.Format == "toml" {
		if mode == Install {
			action = MergeTOMLBlock(agent.MCP.Path)
		} else {
			action = RemoveTOMLBlock(agent.MCP.Path)
		}
	} else if mode == Install {
		action = MergeJSONMember(agent.MCP.Path, agent.MCP.Key, agent.MCP.MemberKey, agent.MCP.Entry)
	} else {
		action = RemoveJSONMember(agent.MCP.Path, agent.MCP.Key, agent.MCP.MemberKey)
	}
	return &WriteResult{Path: agent.MCP.Path, Action: action, Kind: "mcp", Agent: agent.DisplayName}
}

func ApplyInstructions(agent AgentTarget, mode Mode) *WriteResult {
	if agent.InstructionsPath == "" {
		return nil
	}
	action := ActionError
	if mode == Install {
		action = ReplaceOrAppendMarked(agent.InstructionsPath, instructions)
	} else {
		action = RemoveMarked(agent.InstructionsPath)
	}
	return &WriteResult{Path: agent.InstructionsPath, Action: action, Kind: "instructions", Agent: agent.DisplayName}
}

func ApplySubagent(agent AgentTarget, mode Mode) *WriteResult {
	if agent.SubagentPath == "" || agent.SubagentID == "" {
		return nil
	}
	if mode == Uninstall {
		if !fileExists(agent.SubagentPath) {
			return &WriteResult{Path: agent.SubagentPath, Action: ActionNotFound, Kind: "subagent", Agent: agent.DisplayName}
		}
		if err := os.Remove(agent.SubagentPath); err != nil {
			return &WriteResult{Path: agent.SubagentPath, Action: ActionError, Kind: "subagent", Agent: agent.DisplayName}
		}
		return &WriteResult{Path: agent.SubagentPath, Action: ActionRemoved, Kind: "subagent", Agent: agent.DisplayName}
	}
	content, err := miru.LoadAgentTemplate(agent.SubagentID)
	if err != nil {
		return &WriteResult{Path: agent.SubagentPath, Action: ActionError, Kind: "subagent", Agent: agent.DisplayName}
	}
	existed := fileExists(agent.SubagentPath)
	if err := os.MkdirAll(filepath.Dir(agent.SubagentPath), 0o755); err != nil {
		return &WriteResult{Path: agent.SubagentPath, Action: ActionError, Kind: "subagent", Agent: agent.DisplayName}
	}
	if err := os.WriteFile(agent.SubagentPath, []byte(content), 0o644); err != nil {
		return &WriteResult{Path: agent.SubagentPath, Action: ActionError, Kind: "subagent", Agent: agent.DisplayName}
	}
	action := ActionCreated
	if existed {
		action = ActionUpdated
	}
	return &WriteResult{Path: agent.SubagentPath, Action: action, Kind: "subagent", Agent: agent.DisplayName}
}

func jsonMCP(path, key string, entry map[string]any) *MCPConfig {
	return &MCPConfig{Path: path, Key: key, MemberKey: "miru", Entry: entry, Format: "json"}
}

func stdioConfig(withType bool) map[string]any {
	entry := map[string]any{
		"command": "miru",
		"env":     map[string]any{"TAKARA_API_KEY": "${TAKARA_API_KEY}"},
	}
	if withType {
		entry["type"] = "stdio"
	}
	return entry
}

func opencodeMCPPath(home string) string {
	base := filepath.Join(home, ".config", "opencode")
	jsonc := filepath.Join(base, "opencode.jsonc")
	jsonPath := filepath.Join(base, "opencode.json")
	if fileExists(jsonc) {
		return jsonc
	}
	if fileExists(jsonPath) {
		return jsonPath
	}
	return jsonc
}

func vscodeMCPPath(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Code", "User", "mcp.json")
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = home
		}
		return filepath.Join(appData, "Code", "User", "mcp.json")
	default:
		xdg := os.Getenv("XDG_CONFIG_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".config")
		}
		return filepath.Join(xdg, "Code", "User", "mcp.json")
	}
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		return home
	}
	if home = os.Getenv("HOME"); home != "" {
		return home
	}
	return os.Getenv("USERPROFILE")
}

func FormatResults(results []WriteResult) string {
	var out strings.Builder
	for _, result := range results {
		out.WriteString(fmt.Sprintf("%s %-12s %-12s %s\n", result.Agent, result.Kind, result.Action, result.Path))
	}
	return out.String()
}
