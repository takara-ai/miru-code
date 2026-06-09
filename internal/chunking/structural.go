package chunking

import (
	"regexp"
	"sort"
	"strings"
)

var supportedStructuralLanguages = map[string]bool{
	"python":     true,
	"go":         true,
	"typescript": true,
	"javascript": true,
}

func ChunkStructural(source, language string, desiredLength int) ([]Boundary, bool) {
	if language == "" || !supportedStructuralLanguages[language] {
		return nil, false
	}

	lines := SplitLinesKeepEnds(source)
	if len(lines) == 0 {
		return []Boundary{}, true
	}

	var units []Boundary
	if language == "python" {
		units = pythonUnits(lines)
	} else {
		units = braceUnits(lines, language)
	}
	if len(units) == 0 {
		return nil, false
	}
	return MergeAdjacentChunks(units, desiredLength), true
}

func lineIndent(text string) int {
	i := 0
	for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
		i++
	}
	return i
}

func stripLine(text string) string {
	return strings.TrimRight(text, "\r\n")
}

var pythonDeclRE = regexp.MustCompile(`^(async\s+def|def|class)\b`)

func pythonUnits(lines []LineGroup) []Boundary {
	units := []Boundary{}
	firstDeclStart := -1

	for i := range lines {
		raw := stripLine(lines[i].Text)
		trimmed := strings.TrimSpace(raw)
		if !pythonDeclRE.MatchString(trimmed) {
			continue
		}
		if firstDeclStart == -1 {
			firstDeclStart = lines[i].Start
		}

		declIndent := lineIndent(raw)
		if strings.HasPrefix(trimmed, "class ") {
			classEndLine := findPythonBlockEnd(lines, i, declIndent)
			methodStarts := []int{}
			for j := i + 1; j <= classEndLine; j++ {
				innerRaw := stripLine(lines[j].Text)
				innerTrim := strings.TrimSpace(innerRaw)
				if !regexp.MustCompile(`^(async\s+def|def)\b`).MatchString(innerTrim) {
					continue
				}
				if lineIndent(innerRaw) > declIndent {
					methodStarts = append(methodStarts, j)
				}
			}

			if len(methodStarts) > 0 {
				firstMethodStart := methodStarts[0]
				firstMethodEnd := findPythonBlockEnd(lines, firstMethodStart, lineIndent(stripLine(lines[firstMethodStart].Text)))
				units = append(units, Boundary{Start: lines[i].Start, End: lines[firstMethodEnd].End})
				for _, methodStart := range methodStarts[1:] {
					methodIndent := lineIndent(stripLine(lines[methodStart].Text))
					methodEnd := findPythonBlockEnd(lines, methodStart, methodIndent)
					units = append(units, Boundary{Start: lines[methodStart].Start, End: lines[methodEnd].End})
				}
			} else {
				units = append(units, Boundary{Start: lines[i].Start, End: lines[classEndLine].End})
			}
			continue
		}

		startLine := i
		for startLine-1 >= 0 {
			prev := strings.TrimSpace(stripLine(lines[startLine-1].Text))
			if strings.HasPrefix(prev, "@") {
				startLine--
				continue
			}
			break
		}

		endLine := findPythonBlockEnd(lines, i, declIndent)
		if declIndent > 0 {
			continue
		}

		start := lines[startLine].Start
		end := lines[endLine].End
		if end > start {
			units = append(units, Boundary{Start: start, End: end})
		}
	}

	if firstDeclStart > 0 {
		units = append([]Boundary{{Start: 0, End: firstDeclStart}}, units...)
	}
	return dedupeAndSort(units)
}

func findPythonBlockEnd(lines []LineGroup, start, indent int) int {
	endLine := len(lines) - 1
	for j := start + 1; j < len(lines); j++ {
		nextRaw := stripLine(lines[j].Text)
		nextTrim := strings.TrimSpace(nextRaw)
		if nextTrim == "" || strings.HasPrefix(nextTrim, "#") {
			continue
		}
		if lineIndent(nextRaw) <= indent {
			endLine = j - 1
			break
		}
	}
	return endLine
}

func declPattern(language string) *regexp.Regexp {
	if language == "go" {
		return regexp.MustCompile(`^\s*(func\b|type\b.*\b(struct|interface)\b)`)
	}
	return regexp.MustCompile(`^\s*(export\s+)?(async\s+function\b|function\b|class\b|interface\b|type\b|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>)`)
}

func braceUnits(lines []LineGroup, language string) []Boundary {
	units := []Boundary{}
	var full strings.Builder
	for _, line := range lines {
		full.WriteString(line.Text)
	}
	source := full.String()
	re := declPattern(language)
	firstDeclStart := -1

	for i := range lines {
		text := stripLine(lines[i].Text)
		if !re.MatchString(text) {
			continue
		}
		if firstDeclStart == -1 {
			firstDeclStart = lines[i].Start
		}

		startOffset := lines[i].Start
		relativeOpen := strings.Index(source[startOffset:], "{")
		if relativeOpen == -1 {
			continue
		}
		openPos := startOffset + relativeOpen

		limit := len(source)
		if i+60 < len(lines) {
			limit = lines[i+60].End
		}
		if openPos >= limit {
			continue
		}

		depth := 0
		endPos := -1
		for p := openPos; p < len(source); p++ {
			switch source[p] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					endPos = p + 1
					p = len(source)
				}
			}
		}
		if endPos > startOffset {
			extendedEnd := endPos
			for extendedEnd < len(source) && (source[extendedEnd] == ';' || source[extendedEnd] == ' ' || source[extendedEnd] == '\t') {
				extendedEnd++
			}
			if extendedEnd < len(source) && source[extendedEnd] == '\n' {
				extendedEnd++
			}
			units = append(units, Boundary{Start: startOffset, End: extendedEnd})
		}
	}

	if firstDeclStart > 0 {
		units = append([]Boundary{{Start: 0, End: firstDeclStart}}, units...)
	}
	return dedupeAndSort(units)
}

func dedupeAndSort(units []Boundary) []Boundary {
	sort.Slice(units, func(i, j int) bool {
		if units[i].Start == units[j].Start {
			return units[i].End < units[j].End
		}
		return units[i].Start < units[j].Start
	})

	out := make([]Boundary, 0, len(units))
	seen := map[Boundary]bool{}
	for _, unit := range units {
		if seen[unit] {
			continue
		}
		seen[unit] = true
		out = append(out, unit)
	}
	return out
}
