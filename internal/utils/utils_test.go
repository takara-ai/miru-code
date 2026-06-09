package utils

import "testing"

func testChunk(content, filePath string, start, end int) Chunk {
	return Chunk{
		Content:   content,
		FilePath:  filePath,
		StartLine: start,
		EndLine:   end,
		Language:  "python",
	}
}

func TestResolveChunk(t *testing.T) {
	interior := testChunk("line1\nline2\nline3", "src/a.py", 1, 3)
	boundary := testChunk("last line", "src/a.py", 1, 1)

	if ResolveChunk([]Chunk{interior}, "src/a.py", 2) == nil {
		t.Fatal("expected interior chunk")
	}
	if ResolveChunk([]Chunk{boundary}, "src/a.py", 1) == nil {
		t.Fatal("expected boundary chunk")
	}
	if ResolveChunk([]Chunk{interior}, "src/other.py", 1) != nil {
		t.Fatal("expected file path miss")
	}
	if ResolveChunk([]Chunk{interior}, "src/a.py", 99) != nil {
		t.Fatal("expected line miss")
	}
}

func TestIsGitURL(t *testing.T) {
	if !IsGitURL("https://github.com/org/repo") {
		t.Fatal("expected https URL to be git URL")
	}
	if !IsGitURL("git@github.com:org/repo") {
		t.Fatal("expected scp URL to be git URL")
	}
	if IsGitURL("/local/path") || IsGitURL("./relative") {
		t.Fatal("expected local paths not to be git URLs")
	}
}

func TestIsAllowedRepoSource(t *testing.T) {
	if !IsAllowedRepoSource("https://github.com/org/repo") {
		t.Fatal("expected https repo to be allowed")
	}
	if !IsAllowedRepoSource("/tmp/repo") {
		t.Fatal("expected local repo to be allowed")
	}
	if IsAllowedRepoSource("git@github.com:org/repo") {
		t.Fatal("expected scp repo to be rejected")
	}
}

func TestFormatResults(t *testing.T) {
	c := testChunk("def fn(): pass", "f.py", 1, 1)
	out := FormatResults("foo", []SearchResult{{Chunk: c, Score: 0.5}})
	if out.Query != "foo" {
		t.Fatalf("Query = %q, want foo", out.Query)
	}
	if out.Results[0].Score != 0.5 || out.Results[0].Chunk.Location != "f.py:1-1" {
		t.Fatalf("FormatResults() = %#v", out)
	}
}
