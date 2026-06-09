package index

import (
	"path/filepath"
	"strings"

	"github.com/takara-ai/miru-code/internal/utils"
)

func SelectorToMask(selector []int, size int) []bool {
	if len(selector) == 0 {
		return nil
	}
	mask := make([]bool, size)
	for _, idx := range selector {
		if idx >= 0 && idx < size {
			mask[idx] = true
		}
	}
	return mask
}

func EnrichForBM25(chunk utils.Chunk) string {
	parts := strings.Split(strings.ReplaceAll(chunk.FilePath, "\\", "/"), "/")
	stem := ""
	if len(parts) > 0 {
		stem = strings.TrimSuffix(parts[len(parts)-1], filepath.Ext(parts[len(parts)-1]))
	}
	dirParts := []string{}
	for _, part := range parts[:max(0, len(parts)-1)] {
		if part != "" && part != "." && part != ".." {
			dirParts = append(dirParts, part)
		}
	}
	start := max(0, len(dirParts)-3)
	dirText := strings.Join(dirParts[start:], " ")
	return chunk.Content + " " + stem + " " + stem + " " + dirText
}
