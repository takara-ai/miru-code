package installer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

const (
	MiruStart = "<!-- miru:start -->"
	MiruEnd   = "<!-- miru:end -->"

	codexMCPHeader = "[mcp_servers.miru]"
	codexMCPBlock  = `[mcp_servers.miru]
command = "miru"
env = { TAKARA_API_KEY = "${TAKARA_API_KEY}" }
`
)

type Action string

const (
	ActionCreated   Action = "created"
	ActionUpdated   Action = "updated"
	ActionUnchanged Action = "unchanged"
	ActionNotFound  Action = "not-found"
	ActionRemoved   Action = "removed"
	ActionError     Action = "error"
)

func StripJSONComments(text string) string {
	var out strings.Builder
	inString := false
	var quote byte = '"'
	for i := 0; i < len(text); {
		ch := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		if inString {
			out.WriteByte(ch)
			if ch == '\\' && i+1 < len(text) {
				out.WriteByte(next)
				i += 2
				continue
			}
			if ch == quote {
				inString = false
			}
			i++
			continue
		}
		if ch == '"' || ch == '\'' {
			inString = true
			quote = ch
			out.WriteByte(ch)
			i++
			continue
		}
		if ch == '/' && next == '/' {
			for i < len(text) && text[i] != '\n' {
				i++
			}
			continue
		}
		if ch == '/' && next == '*' {
			i += 2
			for i+1 < len(text) && !(text[i] == '*' && text[i+1] == '/') {
				i++
			}
			if i+1 < len(text) {
				i += 2
			}
			continue
		}
		out.WriteByte(ch)
		i++
	}
	return out.String()
}

func MergeJSONMember(path, sectionKey, memberKey string, value map[string]any) Action {
	existed := fileExists(path)
	text := ""
	if existed {
		data, err := os.ReadFile(path)
		if err != nil {
			return ActionError
		}
		text = string(data)
	}
	parsed, ok := parseJSONObject(text)
	if !ok {
		return ActionError
	}
	section, ok := sectionObject(parsed, sectionKey)
	if !ok {
		return ActionError
	}
	if reflect.DeepEqual(section[memberKey], value) {
		return ActionUnchanged
	}
	section[memberKey] = value
	parsed[sectionKey] = section
	data, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return ActionError
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ActionError
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return ActionError
	}
	if existed {
		return ActionUpdated
	}
	return ActionCreated
}

func RemoveJSONMember(path, sectionKey, memberKey string) Action {
	if !fileExists(path) {
		return ActionNotFound
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ActionError
	}
	parsed, ok := parseJSONObject(string(data))
	if !ok {
		return ActionError
	}
	section, ok := sectionObject(parsed, sectionKey)
	if !ok {
		return ActionError
	}
	if _, exists := section[memberKey]; !exists {
		return ActionNotFound
	}
	delete(section, memberKey)
	if len(section) == 0 {
		delete(parsed, sectionKey)
	} else {
		parsed[sectionKey] = section
	}
	if len(parsed) == 0 {
		if err := os.Remove(path); err != nil {
			return ActionError
		}
		return ActionRemoved
	}
	next, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return ActionError
	}
	if err := os.WriteFile(path, append(next, '\n'), 0o644); err != nil {
		return ActionError
	}
	return ActionRemoved
}

func ReplaceOrAppendMarked(path, content string) Action {
	existed := fileExists(path)
	existing := ""
	if existed {
		data, err := os.ReadFile(path)
		if err != nil {
			return ActionError
		}
		existing = string(data)
	}
	start := strings.Index(existing, MiruStart)
	end := strings.Index(existing, MiruEnd)
	if start != -1 && end != -1 && end > start {
		before := existing[:start]
		after := existing[end+len(MiruEnd):]
		updated := before + strings.TrimSpace(content) + "\n" + strings.TrimLeft(after, "\n")
		if updated == existing {
			return ActionUnchanged
		}
		if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
			return ActionError
		}
		return ActionUpdated
	}
	separator := ""
	if existing != "" && !strings.HasSuffix(existing, "\n\n") {
		if strings.HasSuffix(existing, "\n") {
			separator = "\n"
		} else {
			separator = "\n\n"
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ActionError
	}
	if err := os.WriteFile(path, []byte(existing+separator+content), 0o644); err != nil {
		return ActionError
	}
	if existed {
		return ActionUpdated
	}
	return ActionCreated
}

func RemoveMarked(path string) Action {
	if !fileExists(path) {
		return ActionNotFound
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ActionError
	}
	existing := string(data)
	start := strings.Index(existing, MiruStart)
	end := strings.Index(existing, MiruEnd)
	if start == -1 || end == -1 || end <= start {
		return ActionNotFound
	}
	before := strings.TrimRight(existing[:start], "\n")
	after := strings.TrimLeft(existing[end+len(MiruEnd):], "\n")
	parts := []string{}
	if before != "" {
		parts = append(parts, before)
	}
	if after != "" {
		parts = append(parts, after)
	}
	updated := strings.Join(parts, "\n")
	if strings.TrimSpace(updated) == "" {
		if err := os.Remove(path); err != nil {
			return ActionError
		}
		return ActionRemoved
	}
	if err := os.WriteFile(path, []byte(updated+"\n"), 0o644); err != nil {
		return ActionError
	}
	return ActionRemoved
}

func MergeTOMLBlock(path string) Action {
	existed := fileExists(path)
	existing := ""
	if existed {
		data, err := os.ReadFile(path)
		if err != nil {
			return ActionError
		}
		existing = string(data)
	}
	if strings.Contains(existing, strings.TrimSpace(codexMCPBlock)) {
		return ActionUnchanged
	}
	base := strings.TrimRight(stripTOMLSection(existing, codexMCPHeader), "\n")
	next := codexMCPBlock
	if base != "" {
		next = base + "\n\n" + codexMCPBlock
	}
	if !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ActionError
	}
	if err := os.WriteFile(path, []byte(next), 0o644); err != nil {
		return ActionError
	}
	if existed {
		return ActionUpdated
	}
	return ActionCreated
}

func RemoveTOMLBlock(path string) Action {
	if !fileExists(path) {
		return ActionNotFound
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ActionError
	}
	existing := string(data)
	if !strings.Contains(existing, codexMCPHeader) {
		return ActionNotFound
	}
	remaining := strings.TrimSpace(stripTOMLSection(existing, codexMCPHeader))
	if remaining == "" {
		if err := os.Remove(path); err != nil {
			return ActionError
		}
		return ActionRemoved
	}
	if err := os.WriteFile(path, []byte(remaining+"\n"), 0o644); err != nil {
		return ActionError
	}
	return ActionRemoved
}

func parseJSONObject(text string) (map[string]any, bool) {
	if strings.TrimSpace(text) == "" {
		return map[string]any{}, true
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(StripJSONComments(text)), &parsed); err != nil {
		return nil, false
	}
	if parsed == nil {
		return nil, false
	}
	return parsed, true
}

func sectionObject(root map[string]any, sectionKey string) (map[string]any, bool) {
	section, exists := root[sectionKey]
	if !exists {
		return map[string]any{}, true
	}
	obj, ok := section.(map[string]any)
	return obj, ok
}

func stripTOMLSection(text, header string) string {
	prefix := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(header), "["), "]")
	lines := strings.Split(text, "\n")
	result := []string{}
	skipping := false
	for _, line := range lines {
		tableKey := strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		if strings.HasPrefix(tableKey, "[") && strings.HasSuffix(tableKey, "]") {
			tableName := strings.TrimSuffix(strings.TrimPrefix(tableKey, "["), "]")
			if tableName == prefix || strings.HasPrefix(tableName, prefix+".") {
				skipping = true
				continue
			}
			skipping = false
		}
		if !skipping {
			result = append(result, line)
		}
	}
	return strings.Join(result, "\n")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
