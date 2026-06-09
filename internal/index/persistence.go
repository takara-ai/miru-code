package index

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/takara-ai/miru-code/internal/utils"
)

type PersistencePaths struct {
	Root          string
	BM25Index     string
	SemanticIndex string
	Chunks        string
	Metadata      string
}

func PersistencePathsFor(root string) PersistencePaths {
	return PersistencePaths{
		Root:          root,
		BM25Index:     filepath.Join(root, "bm25_index.json"),
		SemanticIndex: filepath.Join(root, "semantic_index"),
		Chunks:        filepath.Join(root, "chunks.json"),
		Metadata:      filepath.Join(root, "metadata.json"),
	}
}

func PathsExist(paths PersistencePaths) []string {
	checks := []struct {
		name string
		path string
	}{
		{"bm25", paths.BM25Index},
		{"semantic", filepath.Join(paths.SemanticIndex, "meta.json")},
		{"chunks", paths.Chunks},
		{"metadata", paths.Metadata},
	}
	missing := []string{}
	for _, check := range checks {
		if _, err := os.Stat(check.path); err != nil {
			missing = append(missing, check.name)
		}
	}
	return missing
}

func SaveBM25(index *BM25Index, path string) error {
	data, err := json.Marshal(index.ToJSON())
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func LoadBM25(path string) (*BM25Index, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var payload BM25JSON
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return BM25FromJSON(payload), nil
}

func SaveSemantic(index SemanticIndex, path string) error {
	switch idx := index.(type) {
	case *QuantizedVectorIndex:
		return idx.Save(path)
	case *VectorIndex:
		return idx.Save(path)
	default:
		return fmt.Errorf("Unsupported semantic index type")
	}
}

func LoadSemantic(path string) (SemanticIndex, error) {
	meta, err := readMeta(path)
	if err != nil {
		return nil, err
	}
	if meta.Storage == "int8" {
		return LoadQuantizedVectorIndex(path)
	}
	return LoadVectorIndex(path)
}

type IndexBundle struct {
	BM25     *BM25Index
	Semantic SemanticIndex
	Chunks   []utils.Chunk
	Metadata map[string]any
}

func SaveIndexBundle(paths PersistencePaths, bundle IndexBundle) error {
	if err := os.MkdirAll(paths.Root, 0o755); err != nil {
		return err
	}
	if err := SaveBM25(bundle.BM25, paths.BM25Index); err != nil {
		return err
	}
	if err := SaveSemantic(bundle.Semantic, paths.SemanticIndex); err != nil {
		return err
	}
	metadata := map[string]any{}
	for key, value := range bundle.Metadata {
		metadata[key] = value
	}
	metadata["vector_storage"] = string(SemanticStorageOf(bundle.Semantic))
	metadataData, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if err := os.WriteFile(paths.Metadata, metadataData, 0o644); err != nil {
		return err
	}

	chunkData := make([]map[string]any, len(bundle.Chunks))
	for i, chunk := range bundle.Chunks {
		chunkData[i] = utils.ChunkToDict(chunk)
	}
	chunksJSON, err := json.Marshal(chunkData)
	if err != nil {
		return err
	}
	return os.WriteFile(paths.Chunks, chunksJSON, 0o644)
}

func LoadIndexBundle(root string) (IndexBundle, error) {
	paths := PersistencePathsFor(root)
	bm25, err := LoadBM25(paths.BM25Index)
	if err != nil {
		return IndexBundle{}, err
	}
	semantic, err := LoadSemantic(paths.SemanticIndex)
	if err != nil {
		return IndexBundle{}, err
	}
	chunkRaw, err := os.ReadFile(paths.Chunks)
	if err != nil {
		return IndexBundle{}, err
	}
	var chunkDicts []map[string]any
	if err := json.Unmarshal(chunkRaw, &chunkDicts); err != nil {
		return IndexBundle{}, err
	}
	chunks := make([]utils.Chunk, len(chunkDicts))
	for i, data := range chunkDicts {
		chunks[i] = utils.ChunkFromDict(data)
	}
	metadataRaw, err := os.ReadFile(paths.Metadata)
	if err != nil {
		return IndexBundle{}, err
	}
	var metadata map[string]any
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		return IndexBundle{}, err
	}
	return IndexBundle{BM25: bm25, Semantic: semantic, Chunks: chunks, Metadata: metadata}, nil
}

func SemanticIndexMatchesStorage(path string) bool {
	meta, err := readMeta(path)
	if err != nil {
		return false
	}
	stored := SemanticFloat32
	if meta.Storage == "int8" {
		stored = SemanticInt8
	}
	return stored == ResolveSemanticStorage()
}
