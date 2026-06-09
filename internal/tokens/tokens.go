package tokens

import (
	"regexp"
	"strings"
)

var tokenRE = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)

func SplitIdentifier(token string) []string {
	lower := strings.ToLower(token)
	var parts []string

	if strings.Contains(token, "_") {
		for _, part := range strings.Split(lower, "_") {
			if part != "" {
				parts = append(parts, part)
			}
		}
	} else {
		for _, part := range splitCamel(token) {
			parts = append(parts, strings.ToLower(part))
		}
	}

	if len(parts) >= 2 {
		out := make([]string, 0, len(parts)+1)
		out = append(out, lower)
		out = append(out, parts...)
		return out
	}
	return []string{lower}
}

func Tokenize(text string) []string {
	raw := tokenRE.FindAllString(text, -1)
	out := make([]string, 0, len(raw))
	for _, tok := range raw {
		out = append(out, SplitIdentifier(tok)...)
	}
	return out
}

func splitCamel(token string) []string {
	parts := []string{}
	for i := 0; i < len(token); {
		switch {
		case isUpper(token[i]):
			j := i
			for j < len(token) && isUpper(token[j]) {
				j++
			}
			if j < len(token) && isLower(token[j]) {
				if j-i > 1 {
					parts = append(parts, token[i:j-1])
					i = j - 1
					continue
				}
				j++
				for j < len(token) && isLower(token[j]) {
					j++
				}
			}
			parts = append(parts, token[i:j])
			i = j
		case isLower(token[i]):
			j := i + 1
			for j < len(token) && isLower(token[j]) {
				j++
			}
			parts = append(parts, token[i:j])
			i = j
		case isDigit(token[i]):
			j := i + 1
			for j < len(token) && isDigit(token[j]) {
				j++
			}
			parts = append(parts, token[i:j])
			i = j
		default:
			i++
		}
	}
	return parts
}

func isUpper(ch byte) bool {
	return ch >= 'A' && ch <= 'Z'
}

func isLower(ch byte) bool {
	return ch >= 'a' && ch <= 'z'
}

func isDigit(ch byte) bool {
	return ch >= '0' && ch <= '9'
}
