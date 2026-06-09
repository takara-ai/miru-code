package search

import (
	"strconv"
	"testing"

	"github.com/takara-ai/miru-code/internal/index"
	"github.com/takara-ai/miru-code/internal/utils"
)

type mockBackend struct {
	vectors [][]float32
}

func (m mockBackend) ModelName() string {
	return "mock"
}

func (m mockBackend) Dimensions() int {
	if len(m.vectors) == 0 {
		return 0
	}
	return len(m.vectors[0])
}

func (m mockBackend) EmbedDocuments(texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, text := range texts {
		idx, err := strconv.Atoi(text)
		if err != nil {
			out[i] = m.vectors[0]
			continue
		}
		out[i] = m.vectors[idx]
	}
	return out, nil
}

func (m mockBackend) EmbedQuery(text string) ([]float32, error) {
	idx, err := strconv.Atoi(text)
	if err != nil {
		return m.vectors[0], nil
	}
	return m.vectors[idx], nil
}

func searchChunk(content, file string) utils.Chunk {
	return utils.Chunk{Content: content, FilePath: file, StartLine: 1, EndLine: 10, Language: "typescript"}
}

func TestHybridSearchSemanticOnlyRetrievalReturnsNearestChunk(t *testing.T) {
	chunks := []utils.Chunk{
		searchChunk("0", "src/auth.ts"),
		searchChunk("1", "src/db.ts"),
		searchChunk("2", "src/util.ts"),
	}
	vectors := [][]float32{unitVector(4, 0), unitVector(4, 1), unitVector(4, 2)}
	bm25 := index.NewBM25Index()
	bm25.Index([][]string{{"0"}, {"1"}, {"2"}})
	semantic := index.NewVectorIndex(vectors)
	alpha := 1.0

	results, err := HybridSearch(HybridOptions{
		Query: "0", Embeddings: mockBackend{vectors: vectors}, SemanticIndex: semantic,
		BM25Index: bm25, Chunks: chunks, TopK: 1, Alpha: &alpha,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Chunk.FilePath != "src/auth.ts" {
		t.Fatalf("results = %#v, want auth chunk", results)
	}
}

func TestHybridSearchBM25OnlyRetrievalRanksLexicalMatchFirst(t *testing.T) {
	chunks := []utils.Chunk{
		searchChunk("database migration schema", "src/db.ts"),
		searchChunk("auth middleware token", "src/auth.ts"),
	}
	vectors := [][]float32{unitVector(4, 0), unitVector(4, 1)}
	bm25 := index.NewBM25Index()
	bm25.Index([][]string{{"database", "migration", "schema"}, {"auth", "middleware", "token"}})
	alpha := 0.0

	results, err := HybridSearch(HybridOptions{
		Query: "auth token", Embeddings: mockBackend{vectors: vectors}, SemanticIndex: index.NewVectorIndex(vectors),
		BM25Index: bm25, Chunks: chunks, TopK: 1, Alpha: &alpha,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) == 0 || results[0].Chunk.FilePath != "src/auth.ts" {
		t.Fatalf("results = %#v, want auth chunk", results)
	}
}

func unitVector(dim, activeIndex int) []float32 {
	v := make([]float32, dim)
	v[activeIndex] = 1
	return v
}
