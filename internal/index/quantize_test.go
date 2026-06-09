package index

import (
	"math"
	"reflect"
	"testing"
)

func TestQuantizedVectorIndexUsesLessMemoryThanFloat32Index(t *testing.T) {
	rand := seededRandom(42)
	vectors := make([][]float32, 100)
	for i := range vectors {
		vectors[i] = normalizedRandom(256, rand)
	}
	floatIndex := NewVectorIndex(vectors)
	quantIndex := NewQuantizedVectorIndex(vectors)
	if !(float64(quantIndex.MemoryBytes()) < float64(floatIndex.MemoryBytes())*0.3) {
		t.Fatalf("quantized memory = %d, float memory = %d", quantIndex.MemoryBytes(), floatIndex.MemoryBytes())
	}
}

func TestQuantizedVectorIndexTop1MatchRateStaysHigh(t *testing.T) {
	dim := 256
	rand := seededRandom(7)
	vectors := make([][]float32, 200)
	for i := range vectors {
		vectors[i] = normalizedRandom(dim, rand)
	}
	floatIndex := NewVectorIndex(vectors)
	quantIndex := NewQuantizedVectorIndex(vectors)

	top1Match := 0
	queries := 40
	queryRand := seededRandom(99)
	for q := 0; q < queries; q++ {
		query := normalizedRandom(dim, queryRand)
		floatTop, err := floatIndex.Query(query, 1)
		if err != nil {
			t.Fatal(err)
		}
		quantTop, err := quantIndex.Query(query, 1)
		if err != nil {
			t.Fatal(err)
		}
		if floatTop.Indices[0] == quantTop.Indices[0] {
			top1Match++
		}
	}
	if float64(top1Match)/float64(queries) <= 0.85 {
		t.Fatalf("top1 match rate = %f", float64(top1Match)/float64(queries))
	}
}

func TestQuantizeVectorRoundTripsApproximately(t *testing.T) {
	v := normalizedRandom(256, seededRandom(3))
	quantized := QuantizeVector(v)
	var errSum float64
	for i := range v {
		approx := float64(quantized.Codes[i]) * quantized.Scale
		errSum += math.Abs(approx - float64(v[i]))
	}
	if errSum/float64(len(v)) >= 0.02 {
		t.Fatalf("mean error = %f", errSum/float64(len(v)))
	}
}

func TestQuantizedVectorIndexPersistence(t *testing.T) {
	dir := t.TempDir()
	vectors := [][]float32{unitVector(8, 0, 1), unitVector(8, 1, 1), unitVector(8, 2, 1)}
	idx := NewQuantizedVectorIndex(vectors)
	if err := idx.Save(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadQuantizedVectorIndex(dir)
	if err != nil {
		t.Fatal(err)
	}
	query := unitVector(8, 0, 0.9)
	before, err := idx.Query(query, 3)
	if err != nil {
		t.Fatal(err)
	}
	after, err := loaded.Query(query, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.Indices, before.Indices) {
		t.Fatalf("indices = %#v, want %#v", after.Indices, before.Indices)
	}
	for i := range before.Distances {
		if math.Abs(after.Distances[i]-before.Distances[i]) > 1e-5 {
			t.Fatalf("distance[%d] = %f, want %f", i, after.Distances[i], before.Distances[i])
		}
	}
	if loaded.MemoryBytes() != idx.MemoryBytes() {
		t.Fatalf("memory = %d, want %d", loaded.MemoryBytes(), idx.MemoryBytes())
	}
}
