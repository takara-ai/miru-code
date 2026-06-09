package cache

import (
	"strings"
	"testing"
)

func TestFindIndexCachePathUsesSHA256Subdir(t *testing.T) {
	path := FindIndexCachePath(".")
	if !strings.HasSuffix(path, "/index") {
		t.Fatalf("cache path = %q, want index suffix", path)
	}
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		t.Fatalf("cache path = %q", path)
	}
	hash := parts[len(parts)-2]
	if len(hash) != 64 {
		t.Fatalf("hash = %q, want 64 hex chars", hash)
	}
}
