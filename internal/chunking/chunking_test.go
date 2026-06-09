package chunking

import "testing"

func TestSplitLinesKeepEnds(t *testing.T) {
	source := "a\nb\r\nc\rd"
	got := SplitLinesKeepEnds(source)
	if len(got) != 4 {
		t.Fatalf("got %d lines, want 4: %#v", len(got), got)
	}
	if got[1].Text != "b\r\n" || got[3].Text != "d" {
		t.Fatalf("SplitLinesKeepEnds() = %#v", got)
	}
}

func TestChunkSourcePreservesLineNumbers(t *testing.T) {
	source := "package main\n\nfunc first() {\n\tprintln(\"a\")\n}\n\nfunc second() {\n\tprintln(\"b\")\n}\n"
	chunks := ChunkSource(source, "main.go", "go")
	if len(chunks) == 0 {
		t.Fatal("ChunkSource() returned no chunks")
	}
	for _, chunk := range chunks {
		if chunk.StartLine <= 0 || chunk.EndLine < chunk.StartLine {
			t.Fatalf("invalid line span: %#v", chunk)
		}
		if chunk.FilePath != "main.go" {
			t.Fatalf("FilePath = %q, want main.go", chunk.FilePath)
		}
	}
}

func TestChunkStructuralYieldsMultipleChunks(t *testing.T) {
	source := "package main\n\nfunc first() {\n\tprintln(\"a\")\n}\n\nfunc second() {\n\tprintln(\"b\")\n}\n"
	boundaries, ok := ChunkStructural(source, "go", 20)
	if !ok || len(boundaries) < 2 {
		t.Fatalf("ChunkStructural() = %#v, %v; want multiple boundaries", boundaries, ok)
	}
}
