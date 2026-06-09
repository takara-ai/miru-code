package index

import "testing"

func TestVectorIndexQuery(t *testing.T) {
	idx := NewVectorIndex([][]float32{
		unitVector(4, 0, 1),
		unitVector(4, 1, 1),
		unitVector(4, 2, 1),
	})
	got, err := idx.Query(unitVector(4, 1, 1), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Indices) != 2 || got.Indices[0] != 1 {
		t.Fatalf("Query() = %#v, want index 1 first", got)
	}
}

func TestVectorIndexPersistence(t *testing.T) {
	dir := t.TempDir()
	idx := NewVectorIndex([][]float32{
		unitVector(4, 0, 1),
		unitVector(4, 1, 1),
	})
	if err := idx.Save(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadVectorIndex(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Size() != idx.Size() || loaded.Dimensions() != idx.Dimensions() {
		t.Fatalf("loaded size/dim = %d/%d, want %d/%d", loaded.Size(), loaded.Dimensions(), idx.Size(), idx.Dimensions())
	}
}
