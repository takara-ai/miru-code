package env

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

const TakaraAPIKeyEnv = "TAKARA_API_KEY"

func Int(name string, fallback int, minValue ...int) int {
	min := 1
	if len(minValue) > 0 {
		min = minValue[0]
	}
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n < float64(min) {
		return fallback
	}
	return int(n)
}

func FirstString(names []string, fallback string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return fallback
}

func OptionalInt(names []string, minValue ...int) (int, bool) {
	min := 1
	if len(minValue) > 0 {
		min = minValue[0]
	}
	for _, name := range names {
		raw := os.Getenv(name)
		if raw == "" {
			continue
		}
		n, err := strconv.ParseFloat(raw, 64)
		if err == nil && n >= float64(min) {
			return int(n), true
		}
	}
	return 0, false
}

func HasTakaraAPIKeyInEnv() bool {
	return strings.TrimSpace(os.Getenv(TakaraAPIKeyEnv)) != ""
}

func ResolveEmbeddingAPIKey() (string, error) {
	key := strings.TrimSpace(os.Getenv(TakaraAPIKeyEnv))
	if key == "" {
		return "", fmt.Errorf("Takara API key required. Run `miru setup`, or set TAKARA_API_KEY in your MCP server env or .env.local")
	}
	return key, nil
}
