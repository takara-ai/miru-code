package index

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

type QueryResult struct {
	Indices   []int
	Distances []float64
}

type VectorIndex struct {
	vectors [][]float32
}

func NewVectorIndex(vectors [][]float32) *VectorIndex {
	return &VectorIndex{vectors: vectors}
}

func (v *VectorIndex) Size() int {
	return len(v.vectors)
}

func (v *VectorIndex) Dimensions() int {
	if len(v.vectors) == 0 {
		return 0
	}
	return len(v.vectors[0])
}

func (v *VectorIndex) Vectors() [][]float32 {
	return v.vectors
}

func (v *VectorIndex) VectorAt(docIndex int) ([]float32, error) {
	if docIndex < 0 || docIndex >= len(v.vectors) {
		return nil, fmt.Errorf("missing vector at index %d", docIndex)
	}
	return v.vectors[docIndex], nil
}

func (v *VectorIndex) MemoryBytes() int {
	return len(v.vectors) * v.Dimensions() * 4
}

func (v *VectorIndex) Query(queryVector []float32, k int, selector ...[]int) (QueryResult, error) {
	if k < 1 {
		return QueryResult{}, fmt.Errorf("k should be >= 1, is now %d", k)
	}
	if len(v.vectors) == 0 {
		return QueryResult{}, nil
	}

	indices := make([]int, len(v.vectors))
	for i := range indices {
		indices[i] = i
	}
	if len(selector) > 0 && selector[0] != nil {
		indices = selector[0]
	}
	effectiveK := min(k, len(indices))
	if effectiveK == 0 {
		return QueryResult{}, nil
	}

	entries := make([]TopKDistanceEntry, 0, len(indices))
	for _, idx := range indices {
		if idx < 0 || idx >= len(v.vectors) {
			continue
		}
		entries = append(entries, TopKDistanceEntry{Index: idx, Distance: cosineDistance(queryVector, v.vectors[idx])})
	}
	top := SelectTopKByDistance(entries, effectiveK)
	return queryResultFromTop(top), nil
}

func (v *VectorIndex) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	dim := v.Dimensions()
	count := v.Size()
	buf := make([]byte, count*dim*4)
	offset := 0
	for _, vector := range v.vectors {
		for _, value := range vector {
			binary.LittleEndian.PutUint32(buf[offset:], math.Float32bits(value))
			offset += 4
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "vectors.bin"), buf, 0o644); err != nil {
		return err
	}
	return writeMeta(dir, semanticMeta{Count: count, Dimensions: dim, Storage: "float32"})
}

func LoadVectorIndex(dir string) (*VectorIndex, error) {
	meta, err := readMeta(dir)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "vectors.bin"))
	if err != nil {
		return nil, err
	}
	vectors := make([][]float32, meta.Count)
	for i := 0; i < meta.Count; i++ {
		vector := make([]float32, meta.Dimensions)
		for j := 0; j < meta.Dimensions; j++ {
			offset := (i*meta.Dimensions + j) * 4
			vector[j] = math.Float32frombits(binary.LittleEndian.Uint32(raw[offset:]))
		}
		vectors[i] = vector
	}
	return NewVectorIndex(vectors), nil
}

func cosineDistance(a, b []float32) float64 {
	var dot float64
	for i := range a {
		var bv float32
		if i < len(b) {
			bv = b[i]
		}
		dot += float64(a[i]) * float64(bv)
	}
	return 1 - dot
}

func queryResultFromTop(top []TopKDistanceEntry) QueryResult {
	result := QueryResult{
		Indices:   make([]int, len(top)),
		Distances: make([]float64, len(top)),
	}
	for i, entry := range top {
		result.Indices[i] = entry.Index
		result.Distances[i] = entry.Distance
	}
	return result
}

type semanticMeta struct {
	Count      int    `json:"count"`
	Dimensions int    `json:"dimensions"`
	Storage    string `json:"storage,omitempty"`
}

func writeMeta(dir string, meta semanticMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o644)
}

func readMeta(dir string) (semanticMeta, error) {
	var meta semanticMeta
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(data, &meta)
	return meta, err
}
