package utils

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
)

type ContentType string

const (
	ContentCode   ContentType = "code"
	ContentDocs   ContentType = "docs"
	ContentConfig ContentType = "config"
)

type Chunk struct {
	Content   string `json:"content"`
	FilePath  string `json:"file_path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Language  string `json:"language"`
}

type SearchResult struct {
	Chunk Chunk
	Score float64
}

func ChunkKey(chunk Chunk) string {
	return chunk.FilePath + ":" + strconv.Itoa(chunk.StartLine) + ":" + strconv.Itoa(chunk.EndLine)
}

type ResultChunk struct {
	Content   string `json:"content"`
	FilePath  string `json:"file_path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Language  string `json:"language"`
	Location  string `json:"location"`
}

type ResultDict struct {
	Score float64     `json:"score"`
	Chunk ResultChunk `json:"chunk"`
}

type FormattedResults struct {
	Query   string       `json:"query"`
	Results []ResultDict `json:"results"`
}

var gitURLSchemes = []string{"https://", "http://", "ssh://", "git://", "git+ssh://", "file://"}

func IsGitURL(path string) bool {
	for _, scheme := range gitURLSchemes {
		if strings.HasPrefix(path, scheme) {
			return true
		}
	}
	return isSCPGitURL(path)
}

func IsAllowedRepoSource(repo string) bool {
	if !IsGitURL(repo) {
		return true
	}
	return strings.HasPrefix(repo, "https://") || strings.HasPrefix(repo, "http://")
}

func ResolveChunk(chunks []Chunk, filePath string, line int) *Chunk {
	var fallback *Chunk
	for i := range chunks {
		chunk := &chunks[i]
		if chunk.FilePath == filePath && chunk.StartLine <= line && line <= chunk.EndLine {
			if line < chunk.EndLine {
				return chunk
			}
			if fallback == nil {
				fallback = chunk
			}
		}
	}
	return fallback
}

func FormatResults(query string, results []SearchResult) FormattedResults {
	out := FormattedResults{Query: query, Results: make([]ResultDict, len(results))}
	for i, result := range results {
		out.Results[i] = ResultDict{
			Score: result.Score,
			Chunk: ResultChunk{
				Content:   result.Chunk.Content,
				FilePath:  result.Chunk.FilePath,
				StartLine: result.Chunk.StartLine,
				EndLine:   result.Chunk.EndLine,
				Language:  result.Chunk.Language,
				Location:  result.Chunk.FilePath + ":" + strconv.Itoa(result.Chunk.StartLine) + "-" + strconv.Itoa(result.Chunk.EndLine),
			},
		}
	}
	return out
}

func ChunkToDict(chunk Chunk) map[string]any {
	language := any(nil)
	if chunk.Language != "" {
		language = chunk.Language
	}
	return map[string]any{
		"content":    chunk.Content,
		"file_path":  chunk.FilePath,
		"start_line": chunk.StartLine,
		"end_line":   chunk.EndLine,
		"language":   language,
		"location":   chunk.FilePath + ":" + strconv.Itoa(chunk.StartLine) + "-" + strconv.Itoa(chunk.EndLine),
	}
}

func ChunkFromDict(data map[string]any) Chunk {
	language := ""
	if value, ok := data["language"]; ok && value != nil {
		language = stringify(value)
	}
	return Chunk{
		Content:   stringify(data["content"]),
		FilePath:  stringify(data["file_path"]),
		StartLine: intify(data["start_line"]),
		EndLine:   intify(data["end_line"]),
		Language:  language,
	}
}

func ResolveContent(raw []string) []ContentType {
	for _, item := range raw {
		if item == "all" {
			return []ContentType{ContentCode, ContentDocs, ContentConfig}
		}
	}

	out := []ContentType{}
	for _, item := range raw {
		switch item {
		case "code":
			out = append(out, ContentCode)
		case "docs":
			out = append(out, ContentDocs)
		case "config":
			out = append(out, ContentConfig)
		}
	}
	return out
}

func ComputeSourceCacheKey(source string, ref *string) string {
	if IsGitURL(source) {
		if ref != nil {
			return source + "@" + *ref
		}
		return source
	}
	abs, err := filepath.Abs(source)
	if err != nil {
		return source
	}
	return abs
}

func stringify(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return strconv.FormatFloat(floatify(value), 'f', -1, 64)
}

func intify(value any) int {
	return int(floatify(value))
}

func floatify(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	default:
		return 0
	}
}

func isSCPGitURL(path string) bool {
	at := strings.IndexByte(path, '@')
	colon := strings.IndexByte(path, ':')
	if at <= 0 || colon <= at+1 {
		return false
	}
	if colon+1 < len(path) && path[colon+1] == '/' {
		return false
	}
	return isGitURLHostish(path[:at]) && isGitURLHostish(path[at+1:colon])
}

func isGitURLHostish(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			continue
		}
		return false
	}
	return true
}
