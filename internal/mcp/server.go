package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"

	miru "github.com/takara-ai/miru-code"
	"github.com/takara-ai/miru-code/internal/utils"
)

const cacheMaxSize = 10

type IndexCache struct {
	content    []utils.ContentType
	defaultRef *string
	mu         sync.Mutex
	entries    map[string]*miru.MiruIndex
	order      []string
}

func NewIndexCache(content []utils.ContentType, defaultRef *string) *IndexCache {
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	return &IndexCache{content: content, defaultRef: defaultRef, entries: map[string]*miru.MiruIndex{}}
}

func (c *IndexCache) Get(source string, ref *string) (*miru.MiruIndex, error) {
	resolvedRef := ref
	if resolvedRef == nil {
		resolvedRef = c.defaultRef
	}
	cacheKey := utils.ComputeSourceCacheKey(source, resolvedRef)
	c.mu.Lock()
	if idx := c.entries[cacheKey]; idx != nil {
		c.mu.Unlock()
		return idx, nil
	}
	c.mu.Unlock()

	var idx *miru.MiruIndex
	var err error
	if utils.IsGitURL(source) {
		idx, err = miru.FromGitRef(source, resolvedRef, c.content)
	} else {
		idx, err = miru.FromPath(source, c.content)
	}
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.order) >= cacheMaxSize {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.entries, oldest)
	}
	c.entries[cacheKey] = idx
	c.order = append(c.order, cacheKey)
	return idx, nil
}

func GetIndexForRepo(repo string, cache *IndexCache, ref *string) (*miru.MiruIndex, error) {
	if repo == "" {
		return nil, fmt.Errorf("Pass an https:// or http:// git URL or local directory path as `repo` (project root for local workspaces).")
	}
	if utils.IsGitURL(repo) && !strings.HasPrefix(repo, "https://") && !strings.HasPrefix(repo, "http://") {
		return nil, fmt.Errorf("Only https://, http://, or local directory paths are accepted as `repo`. Got: %s", repo)
	}
	idx, err := cache.Get(repo, ref)
	if err != nil {
		return nil, fmt.Errorf("Failed to index %s: %s", repo, err.Error())
	}
	return idx, nil
}

func WatchEnabled() bool {
	raw := os.Getenv("MIRU_MCP_WATCH")
	if raw == "" {
		raw = os.Getenv("SEMBLE_MCP_WATCH")
	}
	return raw != "0" && raw != "false"
}

func ShouldIgnoreWatchPath(relativePath string) bool {
	if relativePath == "" {
		return false
	}
	ignored := map[string]bool{
		".git": true, ".hg": true, ".svn": true, "__pycache__": true, "node_modules": true,
		".venv": true, "venv": true, ".tox": true, ".mypy_cache": true, ".pytest_cache": true,
		".ruff_cache": true, ".cache": true, ".miru": true, ".next": true, "dist": true,
		"build": true, ".eggs": true,
	}
	for _, segment := range strings.Split(strings.ReplaceAll(relativePath, "\\", "/"), "/") {
		if segment != "" && ignored[segment] {
			return true
		}
	}
	return false
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func Serve(ref *string, content []utils.ContentType) error {
	cache := NewIndexCache(content, ref)
	reader := bufio.NewReader(os.Stdin)
	for {
		body, err := readMessage(reader)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		var req request
		if err := json.Unmarshal(body, &req); err != nil {
			continue
		}
		if strings.HasPrefix(req.Method, "notifications/") {
			continue
		}
		resp := handle(req, cache)
		if err := writeMessage(os.Stdout, resp); err != nil {
			return err
		}
	}
}

func handle(req request, cache *IndexCache) response {
	switch req.Method {
	case "initialize":
		return response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "miru", "version": "0.1.0"},
			"instructions":    "Instant code search for any local or remote git repository.",
		}}
	case "tools/list":
		return response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"tools": toolsList()}}
	case "tools/call":
		return response{JSONRPC: "2.0", ID: req.ID, Result: handleToolCall(req.Params, cache)}
	default:
		return response{JSONRPC: "2.0", ID: req.ID, Error: map[string]any{"code": -32601, "message": "Method not found"}}
	}
}

func handleToolCall(raw json.RawMessage, cache *IndexCache) any {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return toolText(err.Error())
	}
	switch params.Name {
	case "search":
		query := stringArg(params.Arguments, "query")
		repo := stringArg(params.Arguments, "repo")
		topK := intArg(params.Arguments, "top_k", 5)
		idx, err := GetIndexForRepo(repo, cache, nil)
		if err != nil {
			return toolText(err.Error())
		}
		results, err := idx.Search(query, topK, nil, nil, nil, nil)
		if err != nil {
			return toolText(err.Error())
		}
		if len(results) == 0 {
			return toolText(`{"error":"No results found."}`)
		}
		data, _ := json.Marshal(miru.FormatResults(query, results))
		return toolText(string(data))
	case "find_related":
		filePath := stringArg(params.Arguments, "file_path")
		repo := stringArg(params.Arguments, "repo")
		line := intArg(params.Arguments, "line", 0)
		topK := intArg(params.Arguments, "top_k", 5)
		idx, err := GetIndexForRepo(repo, cache, nil)
		if err != nil {
			return toolText(err.Error())
		}
		chunk := miru.ResolveChunk(idx.Chunks(), filePath, line)
		if chunk == nil {
			return toolText(fmt.Sprintf("No chunk found at %s:%d. Make sure the file is indexed and the line number is within a known chunk.", filePath, line))
		}
		results, err := idx.FindRelated(*chunk, topK)
		if err != nil {
			return toolText(err.Error())
		}
		if len(results) == 0 {
			return toolText(fmt.Sprintf(`{"error":"No related chunks found for %s:%d."}`, filePath, line))
		}
		data, _ := json.Marshal(miru.FormatResults(fmt.Sprintf("Chunks related to %s:%d", filePath, line), results))
		return toolText(string(data))
	default:
		return toolText("Unknown tool: " + params.Name)
	}
}

func toolsList() []map[string]any {
	return []map[string]any{
		{
			"name":        "search",
			"description": "Search a codebase with a natural-language or code query. Indexes `repo` on the first call; later calls reuse the session cache.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Natural language or code query."},
				"repo":  map[string]any{"type": "string", "description": "https:// or http:// git URL or local directory path to index and search."},
				"top_k": map[string]any{"type": "integer", "minimum": 1},
			}, "required": []string{"query", "repo"}},
		},
		{
			"name":        "find_related",
			"description": "Find code chunks semantically similar to a specific location in a file.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"file_path": map[string]any{"type": "string"},
				"line":      map[string]any{"type": "integer"},
				"repo":      map[string]any{"type": "string"},
				"top_k":     map[string]any{"type": "integer", "minimum": 1},
			}, "required": []string{"file_path", "line", "repo"}},
		},
	}
}

func toolText(content string) map[string]any {
	return map[string]any{"content": []map[string]string{{"type": "text", "text": content}}}
}

func readMessage(reader *bufio.Reader) ([]byte, error) {
	contentLength := 0
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), "Content-Length") {
			value, err := strconv.Atoi(strings.TrimSpace(parts[1]))
			if err != nil {
				return nil, err
			}
			contentLength = value
		}
	}
	if contentLength <= 0 {
		return nil, fmt.Errorf("missing Content-Length")
	}
	body := make([]byte, contentLength)
	_, err := io.ReadFull(reader, body)
	return body, err
}

func writeMessage(writer io.Writer, resp response) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(writer, "Content-Length: %d\r\n\r\n", len(data)); err != nil {
		return err
	}
	_, err = writer.Write(data)
	return err
}

func stringArg(args map[string]any, name string) string {
	if value, ok := args[name].(string); ok {
		return value
	}
	return ""
}

func intArg(args map[string]any, name string, fallback int) int {
	switch value := args[name].(type) {
	case float64:
		return int(value)
	case int:
		return value
	default:
		return fallback
	}
}
