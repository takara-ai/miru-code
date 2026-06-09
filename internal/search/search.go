package search

import (
	"regexp"
	"sort"
	"strings"

	"github.com/takara-ai/miru-code/internal/embeddings"
	"github.com/takara-ai/miru-code/internal/index"
	"github.com/takara-ai/miru-code/internal/tokens"
	"github.com/takara-ai/miru-code/internal/utils"
)

const rrfK = 60

var (
	qualifiedSymbolPartRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	camelOrSymbolRE       = regexp.MustCompile(`^(?:_(?:[A-Za-z0-9_]*)|(?:[A-Za-z][A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*)|(?:[A-Z][A-Za-z0-9]*))$`)
)

func IsSymbolQuery(query string) bool {
	q := strings.TrimSpace(query)
	if strings.Contains(q, "::") || strings.Contains(q, "\\") || strings.Contains(q, "->") || strings.Contains(q, ".") {
		parts := strings.FieldsFunc(q, func(r rune) bool {
			return r == ':' || r == '\\' || r == '-' || r == '>' || r == '.'
		})
		if len(parts) < 2 {
			return false
		}
		for _, part := range parts {
			if part == "" || !qualifiedSymbolPartRE.MatchString(part) {
				return false
			}
		}
		return true
	}
	return camelOrSymbolRE.MatchString(q)
}

func ResolveAlpha(query string, alpha *float64) float64 {
	if alpha != nil {
		return *alpha
	}
	if IsSymbolQuery(query) {
		return 0.3
	}
	return 0.5
}

type HybridOptions struct {
	Query         string
	Embeddings    embeddings.Backend
	SemanticIndex index.SemanticIndex
	BM25Index     *index.BM25Index
	Chunks        []utils.Chunk
	TopK          int
	Alpha         *float64
	Selector      []int
	Rerank        bool
}

func HybridSearch(options HybridOptions) ([]utils.SearchResult, error) {
	topK := options.TopK
	if topK == 0 {
		topK = 10
	}
	alphaWeight := ResolveAlpha(options.Query, options.Alpha)
	candidateCount := topK * 5
	chunksByKey := map[string]utils.Chunk{}
	for _, chunk := range options.Chunks {
		chunksByKey[utils.ChunkKey(chunk)] = chunk
	}

	queryVec, err := options.Embeddings.EmbedQuery(options.Query)
	if err != nil {
		return nil, err
	}
	semantic, err := semanticFromQueryVector(queryVec, options.SemanticIndex, options.Chunks, candidateCount, options.Selector)
	if err != nil {
		return nil, err
	}
	bm25Hits := searchBM25(options.Query, options.BM25Index, options.Chunks, candidateCount, options.Selector)

	semanticScores := map[string]float64{}
	for _, result := range semantic {
		semanticScores[utils.ChunkKey(result.Chunk)] = result.Score
	}
	bm25Scores := map[string]float64{}
	for _, result := range bm25Hits {
		if result.Score != 0 {
			bm25Scores[utils.ChunkKey(result.Chunk)] = result.Score
		}
	}

	normalizedSemantic := rrfScores(semanticScores)
	normalizedBM25 := rrfScores(bm25Scores)
	keySet := map[string]bool{}
	for key := range normalizedSemantic {
		keySet[key] = true
	}
	for key := range normalizedBM25 {
		keySet[key] = true
	}
	keys := make([]string, 0, len(keySet))
	for key := range keySet {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return chunksByKey[keys[i]].StartLine < chunksByKey[keys[j]].StartLine
	})

	combinedScores := map[string]float64{}
	for _, key := range keys {
		combinedScores[key] = alphaWeight*normalizedSemantic[key] + (1-alphaWeight)*normalizedBM25[key]
	}
	if options.Rerank {
		BoostMultiChunkFiles(combinedScores, chunksByKey)
		ApplyQueryBoost(combinedScores, options.Query, options.Chunks, chunksByKey)
		return RerankTopK(combinedScores, chunksByKey, topK, alphaWeight < 1.0), nil
	}
	combined := make([]utils.SearchResult, 0, len(combinedScores))
	for key, score := range combinedScores {
		combined = append(combined, utils.SearchResult{Chunk: chunksByKey[key], Score: score})
	}
	sort.Slice(combined, func(i, j int) bool {
		return combined[i].Score > combined[j].Score
	})
	if len(combined) > topK {
		combined = combined[:topK]
	}
	return combined, nil
}

func SearchSemanticOnly(backend embeddings.Backend, semanticIndex index.SemanticIndex, chunks []utils.Chunk, query string, topK int, selector []int) ([]utils.SearchResult, error) {
	queryVec, err := backend.EmbedQuery(query)
	if err != nil {
		return nil, err
	}
	return semanticFromQueryVector(queryVec, semanticIndex, chunks, topK, selector)
}

func rrfScores(scores map[string]float64) map[string]float64 {
	ranked := make([]struct {
		key   string
		score float64
	}, 0, len(scores))
	for key, score := range scores {
		ranked = append(ranked, struct {
			key   string
			score float64
		}{key: key, score: score})
	}
	sort.Slice(ranked, func(i, j int) bool {
		return ranked[i].score > ranked[j].score
	})
	out := map[string]float64{}
	for i, entry := range ranked {
		out[entry.key] = 1.0 / float64(rrfK+i+1)
	}
	return out
}

func semanticFromQueryVector(queryVec []float32, semanticIndex index.SemanticIndex, chunks []utils.Chunk, topK int, selector []int) ([]utils.SearchResult, error) {
	result, err := semanticIndex.Query(queryVec, topK, selector)
	if err != nil {
		return nil, err
	}
	out := []utils.SearchResult{}
	for i, idx := range result.Indices {
		if idx < 0 || idx >= len(chunks) {
			continue
		}
		distance := 0.0
		if i < len(result.Distances) {
			distance = result.Distances[i]
		}
		out = append(out, utils.SearchResult{Chunk: chunks[idx], Score: 1.0 - distance})
	}
	return out, nil
}

func searchBM25(query string, bm25Index *index.BM25Index, chunks []utils.Chunk, topK int, selector []int) []utils.SearchResult {
	queryTokens := tokens.Tokenize(query)
	if len(queryTokens) == 0 || bm25Index == nil {
		return nil
	}
	mask := index.SelectorToMask(selector, len(chunks))
	scores := bm25Index.GetScores(queryTokens, mask)
	indices := index.SelectTopKScoreIndices(scores, topK)
	out := []utils.SearchResult{}
	for _, idx := range indices {
		if idx < 0 || idx >= len(chunks) || scores[idx] <= 0 {
			continue
		}
		out = append(out, utils.SearchResult{Chunk: chunks[idx], Score: scores[idx]})
	}
	return out
}
