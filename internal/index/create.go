package index

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/takara-ai/miru-code/internal/chunking"
	"github.com/takara-ai/miru-code/internal/embeddings"
	"github.com/takara-ai/miru-code/internal/tokens"
	"github.com/takara-ai/miru-code/internal/utils"
)

func CreateIndexFromPath(path string, backend embeddings.Backend, content []utils.ContentType, displayRoot ...string) (*BM25Index, SemanticIndex, []utils.Chunk, error) {
	if len(content) == 0 {
		content = []utils.ContentType{utils.ContentCode}
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return nil, nil, nil, err
	}
	root := resolved
	if len(displayRoot) > 0 && displayRoot[0] != "" {
		root, err = filepath.Abs(displayRoot[0])
		if err != nil {
			return nil, nil, nil, err
		}
	}

	files, err := WalkFiles(resolved, GetExtensions(content))
	if err != nil {
		return nil, nil, nil, err
	}

	chunks := []utils.Chunk{}
	for _, filePath := range files {
		status, err := GetFileStatus(filePath)
		if err != nil || status != FileValid {
			continue
		}
		source, err := ReadFileText(filePath)
		if err != nil {
			continue
		}
		chunkPath := filePath
		if len(displayRoot) > 0 && displayRoot[0] != "" {
			rel, err := filepath.Rel(root, filePath)
			if err == nil {
				chunkPath = filepath.ToSlash(rel)
			}
		}
		for _, chunk := range chunking.ChunkSource(source, chunkPath, DetectLanguage(filePath)) {
			chunks = append(chunks, utils.Chunk{
				Content:   chunk.Content,
				FilePath:  chunk.FilePath,
				StartLine: chunk.StartLine,
				EndLine:   chunk.EndLine,
				Language:  chunk.Language,
			})
		}
	}
	if len(chunks) == 0 {
		return nil, nil, nil, fmt.Errorf("No supported files found under %s.", path)
	}

	texts := make([]string, len(chunks))
	for i, chunk := range chunks {
		texts[i] = chunk.Content
	}
	vectors, err := backend.EmbedDocuments(texts)
	if err != nil {
		return nil, nil, nil, err
	}

	bm25 := NewBM25Index()
	docs := make([][]string, len(chunks))
	for i, chunk := range chunks {
		docs[i] = tokens.Tokenize(EnrichForBM25(chunk))
	}
	bm25.Index(docs)

	return bm25, BuildSemanticIndex(vectors), chunks, nil
}

func NormalizeRelativePath(path string) string {
	return strings.TrimPrefix(filepath.ToSlash(filepath.Clean(path)), "./")
}
