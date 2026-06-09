package index

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/takara-ai/miru-code/internal/utils"
)

const (
	maxFileBytes   = 1_000_000
	emptyFileBytes = 128
)

var extensionToLanguage = map[string]string{
	".py": "python", ".pyi": "python",
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
	".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
	".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
	".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
	".cs": "csharp", ".rb": "ruby", ".php": "php", ".swift": "swift", ".scala": "scala",
	".clj": "clojure", ".cljs": "clojure", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
	".hs": "haskell", ".lua": "lua", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
	".fish": "fish", ".sql": "sql", ".r": "r", ".dart": "dart", ".zig": "zig",
	".vue": "vue", ".svelte": "svelte", ".md": "markdown", ".mdx": "markdown", ".rst": "rst",
	".txt": "text", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
	".ini": "ini", ".cfg": "ini", ".xml": "xml", ".html": "html", ".css": "css",
	".scss": "scss", ".less": "less", ".dockerfile": "dockerfile",
}

var docExtensions = map[string]bool{".md": true, ".mdx": true, ".rst": true, ".txt": true}
var configExtensions = map[string]bool{".json": true, ".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".cfg": true, ".xml": true}

func GetExtensions(types []utils.ContentType) []string {
	exts := map[string]bool{}
	for _, contentType := range types {
		switch contentType {
		case utils.ContentDocs:
			for ext := range docExtensions {
				exts[ext] = true
			}
		case utils.ContentConfig:
			for ext := range configExtensions {
				exts[ext] = true
			}
		case utils.ContentCode:
			for ext, lang := range extensionToLanguage {
				if !isNonCodeLanguage(lang) {
					exts[ext] = true
				}
			}
		}
	}
	out := make([]string, 0, len(exts))
	for ext := range exts {
		out = append(out, ext)
	}
	sort.Strings(out)
	return out
}

func DetectLanguage(filePath string) string {
	if strings.EqualFold(filepath.Base(filePath), "dockerfile") {
		return "dockerfile"
	}
	return extensionToLanguage[strings.ToLower(filepath.Ext(filePath))]
}

type FileStatus string

const (
	FileTooLarge FileStatus = "too_large"
	FileEmpty    FileStatus = "empty"
	FileValid    FileStatus = "valid"
)

func ReadFileText(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func GetFileStatus(filePath string) (FileStatus, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return "", err
	}
	if info.Size() > maxFileBytes {
		return FileTooLarge, nil
	}
	if info.Size() < emptyFileBytes {
		text, err := ReadFileText(filePath)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) == "" {
			return FileEmpty, nil
		}
	}
	return FileValid, nil
}

func isNonCodeLanguage(language string) bool {
	switch language {
	case "markdown", "rst", "text", "json", "yaml", "toml", "ini", "xml", "html":
		return true
	default:
		return false
	}
}
