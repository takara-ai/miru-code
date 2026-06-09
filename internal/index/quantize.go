package index

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

type QuantizedVector struct {
	Codes []int8
	Scale float64
}

func QuantizeVector(vector []float32) QuantizedVector {
	var maxAbs float32
	for _, value := range vector {
		abs := float32(math.Abs(float64(value)))
		if abs > maxAbs {
			maxAbs = abs
		}
	}

	scale := float64(1)
	codes := make([]int8, len(vector))
	if maxAbs > 0 {
		scale = float64(maxAbs) / 127
		inv := 127 / float64(maxAbs)
		for i, value := range vector {
			rounded := jsRound(float64(value) * inv)
			codes[i] = int8(max(-127, min(127, int(rounded))))
		}
	}
	return QuantizedVector{Codes: codes, Scale: scale}
}

type QuantizedVectorIndex struct {
	codes  [][]int8
	scales []float32
	dim    int
}

func NewQuantizedVectorIndex(vectors [][]float32) *QuantizedVectorIndex {
	if len(vectors) == 0 {
		return &QuantizedVectorIndex{}
	}

	dim := len(vectors[0])
	codes := make([][]int8, len(vectors))
	scales := make([]float32, len(vectors))
	for i, vector := range vectors {
		quantized := QuantizeVector(vector)
		codes[i] = quantized.Codes
		scales[i] = float32(quantized.Scale)
	}
	return &QuantizedVectorIndex{codes: codes, scales: scales, dim: dim}
}

func NewQuantizedVectorIndexFromPersisted(codes [][]int8, scales []float32, dim int) *QuantizedVectorIndex {
	return &QuantizedVectorIndex{codes: codes, scales: scales, dim: dim}
}

func (q *QuantizedVectorIndex) Size() int {
	return len(q.codes)
}

func (q *QuantizedVectorIndex) Dimensions() int {
	return q.dim
}

func (q *QuantizedVectorIndex) MemoryBytes() int {
	return len(q.codes)*q.dim + len(q.scales)*4
}

func (q *QuantizedVectorIndex) VectorAt(docIndex int) ([]float32, error) {
	if docIndex < 0 || docIndex >= len(q.codes) || docIndex >= len(q.scales) {
		return nil, fmt.Errorf("missing quantized vector at index %d", docIndex)
	}

	out := make([]float32, len(q.codes[docIndex]))
	scale := q.scales[docIndex]
	for i, code := range q.codes[docIndex] {
		out[i] = float32(code) * scale
	}

	var norm float64
	for _, value := range out {
		norm += float64(value) * float64(value)
	}
	norm = math.Sqrt(norm)
	if norm > 0 {
		for i, value := range out {
			out[i] = float32(float64(value) / norm)
		}
	}
	return out, nil
}

func (q *QuantizedVectorIndex) Query(queryVector []float32, k int, selector ...[]int) (QueryResult, error) {
	if k < 1 {
		return QueryResult{}, fmt.Errorf("k should be >= 1, is now %d", k)
	}
	if q.Size() == 0 {
		return QueryResult{}, nil
	}

	query := QuantizeVector(queryVector)
	indices := make([]int, q.Size())
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
		if idx < 0 || idx >= len(q.codes) || idx >= len(q.scales) {
			continue
		}
		similarity := quantizedDot(query, q.codes[idx], q.scales[idx])
		entries = append(entries, TopKDistanceEntry{Index: idx, Distance: 1 - similarity})
	}
	return queryResultFromTop(SelectTopKByDistance(entries, effectiveK)), nil
}

func (q *QuantizedVectorIndex) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	count := q.Size()
	dim := q.dim
	flatCodes := make([]byte, count*dim)
	for i, codes := range q.codes {
		for j, code := range codes {
			flatCodes[i*dim+j] = byte(code)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "codes.bin"), flatCodes, 0o644); err != nil {
		return err
	}

	scaleBytes := make([]byte, len(q.scales)*4)
	for i, scale := range q.scales {
		binary.LittleEndian.PutUint32(scaleBytes[i*4:], math.Float32bits(scale))
	}
	if err := os.WriteFile(filepath.Join(dir, "scales.bin"), scaleBytes, 0o644); err != nil {
		return err
	}
	return writeMeta(dir, semanticMeta{Count: count, Dimensions: dim, Storage: "int8"})
}

func LoadQuantizedVectorIndex(dir string) (*QuantizedVectorIndex, error) {
	meta, err := readMeta(dir)
	if err != nil {
		return nil, err
	}
	rawCodes, err := os.ReadFile(filepath.Join(dir, "codes.bin"))
	if err != nil {
		return nil, err
	}
	rawScales, err := os.ReadFile(filepath.Join(dir, "scales.bin"))
	if err != nil {
		return nil, err
	}

	codes := make([][]int8, meta.Count)
	for i := 0; i < meta.Count; i++ {
		codes[i] = make([]int8, meta.Dimensions)
		for j := 0; j < meta.Dimensions; j++ {
			codes[i][j] = int8(rawCodes[i*meta.Dimensions+j])
		}
	}
	scales := make([]float32, meta.Count)
	for i := 0; i < meta.Count; i++ {
		scales[i] = math.Float32frombits(binary.LittleEndian.Uint32(rawScales[i*4:]))
	}
	return NewQuantizedVectorIndexFromPersisted(codes, scales, meta.Dimensions), nil
}

func quantizedDot(query QuantizedVector, docCodes []int8, docScale float32) float64 {
	sum := 0
	for i, qCode := range query.Codes {
		var docCode int8
		if i < len(docCodes) {
			docCode = docCodes[i]
		}
		sum += int(qCode) * int(docCode)
	}
	return float64(sum) * query.Scale * float64(docScale)
}

func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}
