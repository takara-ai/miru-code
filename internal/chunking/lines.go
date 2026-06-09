package chunking

import "strings"

type Boundary struct {
	Start int
	End   int
}

type LineGroup struct {
	Boundary
	Text string
}

func MergeAdjacentChunks(chunks []Boundary, desiredLength int) []Boundary {
	if len(chunks) == 0 {
		return nil
	}

	merged := make([]Boundary, 0, len(chunks))
	currentStart := chunks[0].Start
	currentEnd := chunks[0].End
	currentLength := currentEnd - currentStart

	for _, group := range chunks[1:] {
		length := group.End - group.Start
		if currentLength+length > desiredLength {
			merged = append(merged, Boundary{Start: currentStart, End: currentEnd})
			currentStart = group.Start
			currentEnd = group.End
			currentLength = length
			continue
		}
		currentEnd = group.End
		currentLength += length
	}

	merged = append(merged, Boundary{Start: currentStart, End: currentEnd})
	return merged
}

func SplitLinesKeepEnds(source string) []LineGroup {
	groups := []LineGroup{}
	start := 0
	for start < len(source) {
		i := start
		for i < len(source) && source[i] != '\n' && source[i] != '\r' {
			i++
		}
		if i < len(source) {
			if source[i] == '\r' && i+1 < len(source) && source[i+1] == '\n' {
				i += 2
			} else {
				i++
			}
		}
		groups = append(groups, LineGroup{
			Boundary: Boundary{Start: start, End: i},
			Text:     source[start:i],
		})
		start = i
	}
	return groups
}

func ChunkLines(source string, desiredLength int) []Boundary {
	if strings.TrimSpace(source) == "" {
		return nil
	}

	lines := SplitLinesKeepEnds(source)
	boundaries := make([]Boundary, len(lines))
	for i, line := range lines {
		boundaries[i] = line.Boundary
	}
	return MergeAdjacentChunks(boundaries, desiredLength)
}
