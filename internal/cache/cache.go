package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"

	"github.com/takara-ai/miru-code/internal/embeddings"
	"github.com/takara-ai/miru-code/internal/index"
	"github.com/takara-ai/miru-code/internal/utils"
)

func ResolveCacheFolder() string {
	name := "miru"
	home := os.Getenv("HOME")
	if home == "" {
		home = os.Getenv("USERPROFILE")
	}

	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = os.Getenv("APPDATA")
		}
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, name, "Cache")
	case "darwin":
		return filepath.Join(home, "Library", "Caches", name)
	default:
		if xdg := os.Getenv("XDG_CACHE_HOME"); xdg != "" {
			return filepath.Join(xdg, name)
		}
		return filepath.Join(home, ".cache", name)
	}
}

func FindIndexCachePath(path string) string {
	normalized, err := filepath.Abs(path)
	if err != nil {
		normalized = path
	}
	sum := sha256.Sum256([]byte(normalized))
	return filepath.Join(ResolveCacheFolder(), hex.EncodeToString(sum[:]), "index")
}

func ClearCache(path string) error {
	return os.RemoveAll(FindIndexCachePath(path))
}

func GetValidatedCache(path string, embeddingModel string, content []utils.ContentType) (string, bool) {
	indexPath := FindIndexCachePath(path)
	paths := index.PersistencePathsFor(indexPath)
	if missing := index.PathsExist(paths); len(missing) > 0 {
		return "", false
	}
	model := embeddingModel
	if model == "" {
		model = embeddings.ResolveEmbeddingModel()
	}
	raw, err := os.ReadFile(paths.Metadata)
	if err != nil {
		return "", false
	}
	var metadata map[string]any
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return "", false
	}
	if !metadataMatches(metadata, model, content) {
		return "", false
	}
	semanticMetaRaw, err := os.ReadFile(filepath.Join(paths.SemanticIndex, "meta.json"))
	if err != nil {
		return "", false
	}
	var semanticMeta map[string]any
	if err := json.Unmarshal(semanticMetaRaw, &semanticMeta); err != nil {
		return "", false
	}
	if expectedDims, ok := embeddings.ResolveEmbeddingDimensions(model); ok && intFromAny(semanticMeta["dimensions"]) != expectedDims {
		return "", false
	}
	if !index.SemanticIndexMatchesStorage(paths.SemanticIndex) {
		return "", false
	}
	if rootPath := stringFromAny(metadata["root_path"]); rootPath != "" {
		if _, err := os.Stat(rootPath); err != nil {
			return "", false
		}
		for _, rel := range stringSliceFromAny(metadata["file_paths"]) {
			if _, err := os.Stat(filepath.Join(rootPath, rel)); err != nil {
				return "", false
			}
		}
	}
	return indexPath, true
}

func LoadCachedIndex(indexPath string) (index.IndexBundle, error) {
	return index.LoadIndexBundle(indexPath)
}

func metadataMatches(metadata map[string]any, embeddingModel string, content []utils.ContentType) bool {
	if stringFromAny(metadata["embedding_model"]) != embeddingModel {
		return false
	}
	if expectedDims, ok := embeddings.ResolveEmbeddingDimensions(embeddingModel); ok {
		storedDims := intFromAny(metadata["embedding_dimensions"])
		if storedDims != expectedDims {
			return false
		}
	}
	if index.SemanticStorageFromMetadata(metadata) != index.ResolveSemanticStorage() {
		return false
	}
	stored := stringSliceFromAny(metadata["content_type"])
	if len(stored) != len(content) {
		return false
	}
	set := map[string]bool{}
	for _, item := range stored {
		set[item] = true
	}
	for _, item := range content {
		if !set[string(item)] {
			return false
		}
	}
	return true
}

func stringFromAny(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func intFromAny(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}

func stringSliceFromAny(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
