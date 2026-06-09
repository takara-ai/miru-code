package installer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const block = MiruStart + "\n## Miru\ninstructions\n" + MiruEnd + "\n"
const blockV2 = MiruStart + "\n## Miru\nupdated\n" + MiruEnd + "\n"

func TestMergeJSONMemberCreatesFreshMCPConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	if got := MergeJSONMember(path, "mcpServers", "miru", map[string]any{"command": "miru"}); got != ActionCreated {
		t.Fatalf("action = %s, want created", got)
	}
	var data map[string]map[string]map[string]any
	readJSON(t, path, &data)
	if data["mcpServers"]["miru"]["command"] != "miru" {
		t.Fatalf("unexpected data: %#v", data)
	}
}

func TestMergeJSONMemberPreservesOtherEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	writeFile(t, path, `{"mcpServers":{"other":{"command":"x"}}}`)
	if got := MergeJSONMember(path, "mcpServers", "miru", map[string]any{"command": "miru"}); got != ActionUpdated {
		t.Fatalf("action = %s, want updated", got)
	}
	var data map[string]map[string]map[string]any
	readJSON(t, path, &data)
	if data["mcpServers"]["other"]["command"] != "x" || data["mcpServers"]["miru"]["command"] != "miru" {
		t.Fatalf("unexpected data: %#v", data)
	}
}

func TestMergeJSONMemberIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	value := map[string]any{"command": "miru", "args": []any{"--content", "code"}}
	if got := MergeJSONMember(path, "mcpServers", "miru", value); got != ActionCreated {
		t.Fatalf("first action = %s", got)
	}
	if got := MergeJSONMember(path, "mcpServers", "miru", value); got != ActionUnchanged {
		t.Fatalf("second action = %s, want unchanged", got)
	}
}

func TestRemoveJSONMemberRemovesMiruOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	writeFile(t, path, `{"mcpServers":{"miru":{"command":"miru"},"other":{"command":"x"}}}`)
	if got := RemoveJSONMember(path, "mcpServers", "miru"); got != ActionRemoved {
		t.Fatalf("action = %s, want removed", got)
	}
	var data map[string]map[string]map[string]any
	readJSON(t, path, &data)
	if _, ok := data["mcpServers"]["miru"]; ok {
		t.Fatalf("miru entry still present: %#v", data)
	}
	if data["mcpServers"]["other"]["command"] != "x" {
		t.Fatalf("other entry lost: %#v", data)
	}
}

func TestReplaceOrAppendMarkedCreatesAndReplacesBlocks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "CLAUDE.md")
	if got := ReplaceOrAppendMarked(path, block); got != ActionCreated {
		t.Fatalf("action = %s, want created", got)
	}
	if text := readFile(t, path); !strings.Contains(text, MiruStart) {
		t.Fatalf("missing marked block: %q", text)
	}
	if got := ReplaceOrAppendMarked(path, blockV2); got != ActionUpdated {
		t.Fatalf("action = %s, want updated", got)
	}
	text := readFile(t, path)
	if !strings.Contains(text, "updated") || strings.Contains(text, "instructions") {
		t.Fatalf("unexpected text: %q", text)
	}
}

func TestRemoveMarkedStripsBlockAndDeletesEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "CLAUDE.md")
	writeFile(t, path, "# Before\n\n"+block+"\n# After\n")
	if got := RemoveMarked(path); got != ActionRemoved {
		t.Fatalf("action = %s, want removed", got)
	}
	text := readFile(t, path)
	if strings.Contains(text, MiruStart) || !strings.Contains(text, "# Before") || !strings.Contains(text, "# After") {
		t.Fatalf("unexpected text: %q", text)
	}

	writeFile(t, path, block)
	if got := RemoveMarked(path); got != ActionRemoved {
		t.Fatalf("action = %s, want removed", got)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file still exists or unexpected err: %v", err)
	}
}

func TestTOMLMergeAndRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	writeFile(t, path, "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n")
	if got := MergeTOMLBlock(path); got != ActionUpdated {
		t.Fatalf("merge action = %s, want updated", got)
	}
	merged := readFile(t, path)
	if !strings.Contains(merged, "[mcp_servers.miru]") || !strings.Contains(merged, "[mcp_servers.other]") {
		t.Fatalf("unexpected merged TOML: %q", merged)
	}
	if got := MergeTOMLBlock(path); got != ActionUnchanged {
		t.Fatalf("second merge action = %s, want unchanged", got)
	}
	if got := RemoveTOMLBlock(path); got != ActionRemoved {
		t.Fatalf("remove action = %s, want removed", got)
	}
	remaining := readFile(t, path)
	if strings.Contains(remaining, "[mcp_servers.miru]") || !strings.Contains(remaining, "[mcp_servers.other]") {
		t.Fatalf("unexpected remaining TOML: %q", remaining)
	}
}

func readJSON(t *testing.T, path string, out any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
