package search

import (
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/takara-ai/miru-code/internal/tokens"
	"github.com/takara-ai/miru-code/internal/utils"
)

const (
	embeddedStemMinLen        = 4
	embeddedSymbolBoostScale  = 0.5
	definitionBoostMultiplier = 3.0
	stemBoostMultiplier       = 1.0
	fileCoherenceBoostFrac    = 0.2
	strongPenalty             = 0.3
	moderatePenalty           = 0.5
	mildPenalty               = 0.7
	fileSaturationThreshold   = 1
	fileSaturationDecay       = 0.5
)

var (
	embeddedSymbolRE = regexp.MustCompile(`\b(?:[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+)\b`)
	wordRE           = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)
	stopwords        = map[string]bool{}
	testFileRE       = regexp.MustCompile(`(?:^|/)(?:test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go|[^/]*Tests?\.java|[^/]*Test\.php|[^/]*_spec\.rb|[^/]*_test\.rb|[^/]*\.test\.[jt]sx?|[^/]*\.spec\.[jt]sx?|[^/]*Tests?\.kt|[^/]*Spec\.kt|[^/]*Tests?\.swift|[^/]*Spec\.swift|[^/]*Tests?\.cs|test_[^/]*\.cpp|[^/]*_test\.cpp|test_[^/]*\.c|[^/]*_test\.c|[^/]*Spec\.scala|[^/]*Suite\.scala|[^/]*Test\.scala|[^/]*_test\.dart|test_[^/]*\.dart|[^/]*_spec\.lua|[^/]*_test\.lua|test_[^/]*\.lua|test_helpers?[^/]*\.\w+)$`)
	testDirRE        = regexp.MustCompile(`(?:^|/)(?:tests?|__tests__|spec|testing)(?:/|$)`)
	compatDirRE      = regexp.MustCompile(`(?:^|/)(?:compat|_compat|legacy)(?:/|$)`)
	examplesDirRE    = regexp.MustCompile(`(?:^|/)(?:_?examples?|docs?_src)(?:/|$)`)
)

var definitionKeywords = []string{
	"class", "module", "defmodule", "def", "interface", "struct", "enum", "trait",
	"type", "func", "function", "object", "abstract class", "data class", "fn", "fun",
	"package", "namespace", "protocol", "record", "typedef",
}

var sqlDefinitionKeywords = []string{"CREATE TABLE", "CREATE VIEW", "CREATE PROCEDURE", "CREATE FUNCTION"}
var reexportFilenames = map[string]bool{"__init__.py": true, "package-info.java": true}

func init() {
	for _, word := range strings.Split("a an and are as at be by do does for from has have how if in is it not of on or the to was what when where which who why with", " ") {
		stopwords[word] = true
	}
}

func BoostMultiChunkFiles(scores map[string]float64, chunksByKey map[string]utils.Chunk) {
	if len(scores) == 0 {
		return
	}
	maxScore := maxScore(scores)
	if maxScore == 0 {
		return
	}
	fileSum := map[string]float64{}
	bestChunk := map[string]string{}
	for key, score := range scores {
		chunk, ok := chunksByKey[key]
		if !ok {
			continue
		}
		fileSum[chunk.FilePath] += score
		best, ok := bestChunk[chunk.FilePath]
		if !ok || score > scores[best] {
			bestChunk[chunk.FilePath] = key
		}
	}
	maxFileSum := 0.0
	for _, sum := range fileSum {
		if sum > maxFileSum {
			maxFileSum = sum
		}
	}
	boostUnit := maxScore * fileCoherenceBoostFrac
	for fp, key := range bestChunk {
		scores[key] += boostUnit * (fileSum[fp] / maxFileSum)
	}
}

func ApplyQueryBoost(scores map[string]float64, query string, allChunks []utils.Chunk, chunksByKey map[string]utils.Chunk) map[string]float64 {
	if len(scores) == 0 {
		return scores
	}
	max := maxScore(scores)
	if IsSymbolQuery(query) {
		boostSymbolDefinitions(scores, query, max, allChunks, chunksByKey)
	} else {
		boostStemMatches(scores, query, max, chunksByKey)
		boostEmbeddedSymbols(scores, query, max, allChunks, chunksByKey)
	}
	return scores
}

func RerankTopK(scores map[string]float64, chunksByKey map[string]utils.Chunk, topK int, penalisePaths bool) []utils.SearchResult {
	if len(scores) == 0 {
		return nil
	}
	penaltyCache := map[string]float64{}
	type entry struct {
		key   string
		score float64
	}
	ranked := []entry{}
	for key, score := range scores {
		chunk, ok := chunksByKey[key]
		if !ok {
			continue
		}
		penalized := score
		if penalisePaths {
			mult, ok := penaltyCache[chunk.FilePath]
			if !ok {
				mult = filePathPenalty(chunk.FilePath)
				penaltyCache[chunk.FilePath] = mult
			}
			penalized *= mult
		}
		ranked = append(ranked, entry{key: key, score: penalized})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })

	fileSelected := map[string]int{}
	selected := []entry{}
	minSelected := math.Inf(1)
	for _, item := range ranked {
		chunk := chunksByKey[item.key]
		if len(selected) >= topK && item.score <= minSelected {
			break
		}
		already := fileSelected[chunk.FilePath]
		effective := item.score
		if already >= fileSaturationThreshold {
			excess := already - fileSaturationThreshold + 1
			for i := 0; i < excess; i++ {
				effective *= fileSaturationDecay
			}
		}
		selected = append(selected, entry{key: item.key, score: effective})
		fileSelected[chunk.FilePath] = already + 1
		if len(selected) >= topK {
			minSelected = selected[0].score
			for _, selectedItem := range selected {
				if selectedItem.score < minSelected {
					minSelected = selectedItem.score
				}
			}
		}
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].score > selected[j].score })
	if len(selected) > topK {
		selected = selected[:topK]
	}
	out := make([]utils.SearchResult, 0, len(selected))
	for _, item := range selected {
		out = append(out, utils.SearchResult{Chunk: chunksByKey[item.key], Score: item.score})
	}
	return out
}

func boostSymbolDefinitions(scores map[string]float64, query string, maxScore float64, allChunks []utils.Chunk, chunksByKey map[string]utils.Chunk) {
	symbolName := extractSymbolName(query)
	names := map[string]bool{symbolName: true}
	if symbolName != strings.TrimSpace(query) {
		names[strings.TrimSpace(query)] = true
	}
	boostUnit := maxScore * definitionBoostMultiplier
	for key := range scores {
		chunk, ok := chunksByKey[key]
		if !ok {
			continue
		}
		if tier := definitionTier(chunk, names, boostUnit); tier != 0 {
			scores[key] += tier
		}
	}
	for _, chunk := range allChunks {
		key := utils.ChunkKey(chunk)
		if _, ok := scores[key]; ok {
			continue
		}
		stem := strings.ToLower(trimExt(filepath.Base(chunk.FilePath)))
		if !anyNameMatchesStem(names, stem) {
			continue
		}
		if tier := definitionTier(chunk, names, boostUnit); tier != 0 {
			scores[key] = tier
		}
	}
}

func boostEmbeddedSymbols(scores map[string]float64, query string, maxScore float64, allChunks []utils.Chunk, chunksByKey map[string]utils.Chunk) {
	names := embeddedSymbolRE.FindAllString(query, -1)
	if len(names) == 0 {
		return
	}
	nameSet := map[string]bool{}
	symbolsLower := map[string]bool{}
	for _, name := range names {
		nameSet[name] = true
		symbolsLower[strings.ToLower(name)] = true
	}
	boostUnit := maxScore * definitionBoostMultiplier * embeddedSymbolBoostScale
	for key := range scores {
		chunk, ok := chunksByKey[key]
		if !ok {
			continue
		}
		if tier := definitionTier(chunk, nameSet, boostUnit); tier != 0 {
			scores[key] += tier
		}
	}
	for _, chunk := range allChunks {
		key := utils.ChunkKey(chunk)
		if _, ok := scores[key]; ok {
			continue
		}
		stem := strings.ToLower(trimExt(filepath.Base(chunk.FilePath)))
		stemNorm := strings.ReplaceAll(stem, "_", "")
		ok := false
		for symbolLower := range symbolsLower {
			if stem == symbolLower || stemNorm == symbolLower ||
				(len(stem) >= embeddedStemMinLen && strings.HasPrefix(symbolLower, stem)) ||
				(len(stemNorm) >= embeddedStemMinLen && strings.HasPrefix(symbolLower, stemNorm)) {
				ok = true
				break
			}
		}
		if !ok {
			continue
		}
		if tier := definitionTier(chunk, nameSet, boostUnit); tier != 0 {
			scores[key] = tier
		}
	}
}

func boostStemMatches(scores map[string]float64, query string, maxScore float64, chunksByKey map[string]utils.Chunk) {
	keywords := map[string]bool{}
	for _, word := range wordRE.FindAllString(query, -1) {
		lower := strings.ToLower(word)
		if len(word) > 2 && !stopwords[lower] {
			keywords[lower] = true
		}
	}
	if len(keywords) == 0 {
		return
	}
	boost := maxScore * stemBoostMultiplier
	pathCache := map[string]map[string]bool{}
	for key := range scores {
		chunk, ok := chunksByKey[key]
		if !ok {
			continue
		}
		parts, ok := pathCache[chunk.FilePath]
		if !ok {
			parts = map[string]bool{}
			for _, part := range tokens.SplitIdentifier(trimExt(filepath.Base(chunk.FilePath))) {
				parts[part] = true
			}
			parent := filepath.Base(filepath.Dir(chunk.FilePath))
			if parent != "" && parent != "." && parent != ".." {
				for _, part := range tokens.SplitIdentifier(parent) {
					parts[part] = true
				}
			}
			pathCache[chunk.FilePath] = parts
		}
		nMatches := countKeywordMatches(keywords, parts)
		if nMatches > 0 {
			matchRatio := float64(nMatches) / float64(len(keywords))
			if matchRatio >= 0.1 {
				scores[key] += boost * matchRatio
			}
		}
	}
}

func definitionTier(chunk utils.Chunk, names map[string]bool, boostUnit float64) float64 {
	defines := false
	for name := range names {
		if chunkDefinesSymbol(chunk, name) {
			defines = true
			break
		}
	}
	if !defines {
		return 0
	}
	stem := strings.ToLower(trimExt(filepath.Base(chunk.FilePath)))
	if anyNameMatchesStem(names, stem) {
		return boostUnit * 1.5
	}
	return boostUnit
}

func chunkDefinesSymbol(chunk utils.Chunk, symbolName string) bool {
	escaped := regexp.QuoteMeta(symbolName)
	nsPrefix := `(?:[A-Za-z_][A-Za-z0-9_]*(?:\.|::))*`
	suffix := `\s+` + nsPrefix + escaped + `(?:\s|[<({:\[;]|$)`
	for _, keyword := range definitionKeywords {
		pattern := `(?m)(^|\s)` + strings.ReplaceAll(regexp.QuoteMeta(keyword), " ", `\s+`) + suffix
		if regexp.MustCompile(pattern).FindStringIndex(chunk.Content) != nil {
			return true
		}
	}
	for _, keyword := range sqlDefinitionKeywords {
		pattern := `(?im)(^|\s)` + strings.ReplaceAll(regexp.QuoteMeta(keyword), " ", `\s+`) + suffix
		if regexp.MustCompile(pattern).FindStringIndex(chunk.Content) != nil {
			return true
		}
	}
	return false
}

func countKeywordMatches(keywords, parts map[string]bool) int {
	exact := 0
	for keyword := range keywords {
		if parts[keyword] {
			exact++
		}
	}
	if exact == len(keywords) {
		return exact
	}
	matches := exact
	for keyword := range keywords {
		if parts[keyword] {
			continue
		}
		for part := range parts {
			shorter, longer := keyword, part
			if len(part) < len(keyword) {
				shorter, longer = part, keyword
			}
			if len(shorter) >= 3 && strings.HasPrefix(longer, shorter) {
				matches++
				break
			}
		}
	}
	return matches
}

func extractSymbolName(query string) string {
	for _, sep := range []string{"::", "\\", "->", "."} {
		if strings.Contains(query, sep) {
			parts := strings.Split(query, sep)
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	return strings.TrimSpace(query)
}

func stemMatches(stem, name string) bool {
	stemNorm := strings.ReplaceAll(stem, "_", "")
	return stem == name || stemNorm == name || strings.TrimSuffix(stem, "s") == name || strings.TrimSuffix(stemNorm, "s") == name
}

func anyNameMatchesStem(names map[string]bool, stem string) bool {
	for name := range names {
		if stemMatches(stem, strings.ToLower(name)) {
			return true
		}
	}
	return false
}

func filePathPenalty(filePath string) float64 {
	normalised := strings.ReplaceAll(filePath, "\\", "/")
	penalty := 1.0
	if testFileRE.MatchString(normalised) || testDirRE.MatchString(normalised) {
		penalty *= strongPenalty
	}
	if reexportFilenames[filepath.Base(filePath)] {
		penalty *= moderatePenalty
	}
	if compatDirRE.MatchString(normalised) {
		penalty *= strongPenalty
	}
	if examplesDirRE.MatchString(normalised) {
		penalty *= strongPenalty
	}
	if strings.HasSuffix(normalised, ".d.ts") {
		penalty *= mildPenalty
	}
	return penalty
}

func maxScore(scores map[string]float64) float64 {
	max := 0.0
	for _, score := range scores {
		if score > max {
			max = score
		}
	}
	return max
}

func trimExt(path string) string {
	return strings.TrimSuffix(path, filepath.Ext(path))
}
