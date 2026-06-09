package chunking

import "strings"

const DesiredChunkLengthChars = 1500

type Chunk struct {
	Content   string
	FilePath  string
	StartLine int
	EndLine   int
	Language  string
}

func ChunkSource(source, filePath, language string) []Chunk {
	if strings.TrimSpace(source) == "" {
		return nil
	}

	boundaries, ok := ChunkStructural(source, language, DesiredChunkLengthChars)
	if !ok {
		boundaries = ChunkLines(source, DesiredChunkLengthChars)
	}

	prefixNewlineCounts := make([]uint32, len(source)+1)
	for i := 0; i < len(source); i++ {
		prefixNewlineCounts[i+1] = prefixNewlineCounts[i]
		if source[i] == '\n' {
			prefixNewlineCounts[i+1]++
		}
	}

	chunks := make([]Chunk, 0, len(boundaries))
	for _, boundary := range boundaries {
		endIndex := max(boundary.End-1, boundary.Start)
		text := source[boundary.Start : endIndex+1]
		chunks = append(chunks, Chunk{
			Content:   text,
			FilePath:  filePath,
			StartLine: int(prefixNewlineCounts[boundary.Start]) + 1,
			EndLine:   int(prefixNewlineCounts[endIndex]) + 1,
			Language:  language,
		})
	}
	return chunks
}
