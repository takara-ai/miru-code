package miru

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/takara-ai/miru-code/internal/cache"
	"github.com/takara-ai/miru-code/internal/embeddings"
	"github.com/takara-ai/miru-code/internal/git"
	"github.com/takara-ai/miru-code/internal/index"
	"github.com/takara-ai/miru-code/internal/search"
	"github.com/takara-ai/miru-code/internal/utils"
)

//go:embed src/agents/*.md
var agentTemplates embed.FS

type Chunk = utils.Chunk
type ContentType = utils.ContentType
type SearchResult = utils.SearchResult
type AgentID string

const (
	ContentCode   = utils.ContentCode
	ContentDocs   = utils.ContentDocs
	ContentConfig = utils.ContentConfig

	AgentClaude   AgentID = "claude"
	AgentCopilot  AgentID = "copilot"
	AgentCursor   AgentID = "cursor"
	AgentGemini   AgentID = "gemini"
	AgentKiro     AgentID = "kiro"
	AgentOpenCode AgentID = "opencode"
)

type MiruIndex struct {
	embeddings      embeddings.Backend
	chunks          []utils.Chunk
	bm25Index       *index.BM25Index
	semanticIndex   index.SemanticIndex
	loadedFromDisk  bool
	embeddingModel  string
	root            string
	content         []utils.ContentType
	fileMapping     map[string][]int
	languageMapping map[string][]int
}

type NewOptions struct {
	Embeddings     embeddings.Backend
	BM25Index      *index.BM25Index
	SemanticIndex  index.SemanticIndex
	Chunks         []utils.Chunk
	EmbeddingModel string
	Root           string
	Content        []utils.ContentType
	LoadedFromDisk bool
}

func New(options NewOptions) *MiruIndex {
	content := options.Content
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	idx := &MiruIndex{
		embeddings:      options.Embeddings,
		chunks:          options.Chunks,
		bm25Index:       options.BM25Index,
		semanticIndex:   options.SemanticIndex,
		loadedFromDisk:  options.LoadedFromDisk,
		embeddingModel:  options.EmbeddingModel,
		root:            options.Root,
		content:         content,
		fileMapping:     map[string][]int{},
		languageMapping: map[string][]int{},
	}
	idx.rebuildMappings()
	return idx
}

func FromSource(source string, content []utils.ContentType, embeddingModel ...string) (*MiruIndex, error) {
	if utils.IsGitURL(source) {
		return FromGit(source, content, embeddingModel...)
	}
	return FromPath(source, content, embeddingModel...)
}

func FromGit(url string, content []utils.ContentType, embeddingModel ...string) (*MiruIndex, error) {
	return FromGitRef(url, nil, content, embeddingModel...)
}

func FromGitRef(url string, ref *string, content []utils.ContentType, embeddingModel ...string) (*MiruIndex, error) {
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	cacheKey := utils.ComputeSourceCacheKey(url, ref)
	model := embeddings.ResolveEmbeddingModel()
	if len(embeddingModel) > 0 && embeddingModel[0] != "" {
		model = embeddingModel[0]
	}
	if cached, ok := cache.GetValidatedCache(cacheKey, model, content); ok {
		return LoadFromDisk(cached, model)
	}
	cloneDir, err := git.CloneRepository(url, ref)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(cloneDir)
	idx, err := FromPathNoCache(cloneDir, content, model)
	if err != nil {
		return nil, err
	}
	idx.root = ""
	if err := idx.Save(cache.FindIndexCachePath(cacheKey)); err != nil {
		return nil, err
	}
	return idx, nil
}

func FromPath(path string, content []utils.ContentType, embeddingModel ...string) (*MiruIndex, error) {
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("Path does not exist: %s", path)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("Path is not a directory: %s", path)
	}

	model := embeddings.ResolveEmbeddingModel()
	if len(embeddingModel) > 0 && embeddingModel[0] != "" {
		model = embeddingModel[0]
	}
	if cached, ok := cache.GetValidatedCache(resolved, model, content); ok {
		return LoadFromDisk(cached, model)
	}
	return FromPathNoCache(resolved, content, model)
}

func FromPathNoCache(path string, content []utils.ContentType, embeddingModel ...string) (*MiruIndex, error) {
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	model := embeddings.ResolveEmbeddingModel()
	if len(embeddingModel) > 0 && embeddingModel[0] != "" {
		model = embeddingModel[0]
	}
	dimensions, hasDimensions := embeddings.ResolveEmbeddingDimensions(model)
	var dimsPtr *int
	if hasDimensions {
		dimsPtr = &dimensions
	}
	backend, err := embeddings.NewOpenAIBackend(embeddings.Options{Model: model, Dimensions: dimsPtr})
	if err != nil {
		return nil, err
	}
	bm25, semantic, chunks, err := index.CreateIndexFromPath(resolved, backend, content, resolved)
	if err != nil {
		return nil, err
	}
	return New(NewOptions{
		Embeddings: backend, BM25Index: bm25, SemanticIndex: semantic, Chunks: chunks,
		EmbeddingModel: model, Root: resolved, Content: content,
	}), nil
}

func LoadFromDisk(path string, embeddingModel ...string) (*MiruIndex, error) {
	model := embeddings.ResolveEmbeddingModel()
	if len(embeddingModel) > 0 && embeddingModel[0] != "" {
		model = embeddingModel[0]
	}
	bundle, err := cache.LoadCachedIndex(path)
	if err != nil {
		return nil, err
	}
	backend, err := embeddings.NewOpenAIBackend(embeddings.Options{Model: model})
	if err != nil {
		return nil, err
	}
	content := []utils.ContentType{utils.ContentCode}
	if raw, ok := bundle.Metadata["content_type"].([]any); ok {
		content = []utils.ContentType{}
		for _, item := range raw {
			if s, ok := item.(string); ok {
				content = append(content, utils.ContentType(s))
			}
		}
	}
	root := ""
	if s, ok := bundle.Metadata["root_path"].(string); ok {
		root = s
	}
	return New(NewOptions{
		Embeddings: backend, BM25Index: bundle.BM25, SemanticIndex: bundle.Semantic, Chunks: bundle.Chunks,
		EmbeddingModel: model, Root: root, Content: content, LoadedFromDisk: true,
	}), nil
}

func (m *MiruIndex) Chunks() []utils.Chunk {
	return m.chunks
}

func (m *MiruIndex) LoadedFromDisk() bool {
	return m.loadedFromDisk
}

func (m *MiruIndex) Search(query string, topK int, alpha *float64, filterLanguages, filterPaths []string, rerank *bool) ([]utils.SearchResult, error) {
	if len(m.chunks) == 0 || query == "" {
		return nil, nil
	}
	resolvedRerank := containsContent(m.content, utils.ContentCode)
	if rerank != nil {
		resolvedRerank = *rerank
	}
	return search.HybridSearch(search.HybridOptions{
		Query: query, Embeddings: m.embeddings, SemanticIndex: m.semanticIndex, BM25Index: m.bm25Index,
		Chunks: m.chunks, TopK: topK, Alpha: alpha, Selector: m.getSelector(filterLanguages, filterPaths),
		Rerank: resolvedRerank,
	})
}

func (m *MiruIndex) FindRelated(source utils.Chunk, topK int) ([]utils.SearchResult, error) {
	selector := []int(nil)
	if source.Language != "" {
		selector = m.getSelector([]string{source.Language}, nil)
	}
	results, err := search.SearchSemanticOnly(m.embeddings, m.semanticIndex, m.chunks, source.Content, topK+1, selector)
	if err != nil {
		return nil, err
	}
	out := []utils.SearchResult{}
	targetKey := utils.ChunkKey(source)
	for _, result := range results {
		if utils.ChunkKey(result.Chunk) != targetKey {
			out = append(out, result)
		}
		if len(out) >= topK {
			break
		}
	}
	return out, nil
}

func (m *MiruIndex) SaveToDefaultCache(sourcePath string) error {
	if m.loadedFromDisk {
		return nil
	}
	return m.Save(cache.FindIndexCachePath(sourcePath))
}

func (m *MiruIndex) Save(path string) error {
	dims := m.embeddings.Dimensions()
	if dims == 0 {
		if resolved, ok := embeddings.ResolveEmbeddingDimensions(m.embeddingModel); ok {
			dims = resolved
		}
	}
	filePaths := make([]string, 0, len(m.fileMapping))
	for fp := range m.fileMapping {
		filePaths = append(filePaths, fp)
	}
	sort.Strings(filePaths)
	content := make([]string, len(m.content))
	for i, item := range m.content {
		content[i] = string(item)
	}
	return index.SaveIndexBundle(index.PersistencePathsFor(path), index.IndexBundle{
		BM25:     m.bm25Index,
		Semantic: m.semanticIndex,
		Chunks:   m.chunks,
		Metadata: map[string]any{
			"root_path":            emptyStringAsNil(m.root),
			"time":                 float64(time.Now().UnixNano()) / 1e9,
			"embedding_model":      m.embeddingModel,
			"embedding_dimensions": dims,
			"embedding_provider":   "openai",
			"content_type":         content,
			"file_paths":           filePaths,
		},
	})
}

func ClearCache(path string) error {
	return cache.ClearCache(path)
}

func ResolveCacheFolder() string {
	return cache.ResolveCacheFolder()
}

func FindIndexCachePath(path string) string {
	return cache.FindIndexCachePath(path)
}

func ResolveContent(raw []string) []utils.ContentType {
	return utils.ResolveContent(raw)
}

func ResolveChunk(chunks []utils.Chunk, filePath string, line int) *utils.Chunk {
	return utils.ResolveChunk(chunks, filePath, line)
}

func FormatResults(query string, results []utils.SearchResult) utils.FormattedResults {
	return utils.FormatResults(query, results)
}

func AgentDestination(agent AgentID) string {
	baseDir := "." + string(agent)
	if agent == AgentCopilot {
		baseDir = ".github"
	}
	return filepath.Join(baseDir, "agents", "miru-code.md")
}

func LoadAgentTemplate(agent AgentID) (string, error) {
	data, err := agentTemplates.ReadFile(filepath.ToSlash(filepath.Join("src", "agents", string(agent)+".md")))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func WriteAgentFile(agent AgentID, force bool) (string, error) {
	if !isAgentID(agent) {
		return "", fmt.Errorf("Unknown agent %q. Choose one of: claude, copilot, cursor, gemini, kiro, opencode", agent)
	}
	dest := AgentDestination(agent)
	if !force {
		if _, err := os.Stat(dest); err == nil {
			return "", fmt.Errorf("%s already exists. Run with --force to overwrite", dest)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	content, err := LoadAgentTemplate(agent)
	if err != nil {
		return "", err
	}
	return dest, os.WriteFile(dest, []byte(content), 0o644)
}

func (m *MiruIndex) rebuildMappings() {
	m.fileMapping = map[string][]int{}
	m.languageMapping = map[string][]int{}
	for i, chunk := range m.chunks {
		m.fileMapping[chunk.FilePath] = append(m.fileMapping[chunk.FilePath], i)
		if chunk.Language != "" {
			m.languageMapping[chunk.Language] = append(m.languageMapping[chunk.Language], i)
		}
	}
}

func (m *MiruIndex) getSelector(filterLanguages, filterPaths []string) []int {
	selectorSet := map[int]bool{}
	for _, language := range filterLanguages {
		for _, idx := range m.languageMapping[language] {
			selectorSet[idx] = true
		}
	}
	for _, filePath := range filterPaths {
		for _, idx := range m.fileMapping[filePath] {
			selectorSet[idx] = true
		}
	}
	if len(selectorSet) == 0 {
		return nil
	}
	selector := make([]int, 0, len(selectorSet))
	for idx := range selectorSet {
		selector = append(selector, idx)
	}
	return selector
}

func containsContent(content []utils.ContentType, target utils.ContentType) bool {
	for _, item := range content {
		if item == target {
			return true
		}
	}
	return false
}

func emptyStringAsNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func isAgentID(agent AgentID) bool {
	switch agent {
	case AgentClaude, AgentCopilot, AgentCursor, AgentGemini, AgentKiro, AgentOpenCode:
		return true
	default:
		return false
	}
}
