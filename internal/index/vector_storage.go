package index

import "os"

type SemanticIndex interface {
	Size() int
	Dimensions() int
	MemoryBytes() int
	VectorAt(docIndex int) ([]float32, error)
	Query(queryVector []float32, k int, selector ...[]int) (QueryResult, error)
}

type SemanticStorage string

const (
	SemanticInt8    SemanticStorage = "int8"
	SemanticFloat32 SemanticStorage = "float32"
)

func ResolveSemanticStorage() SemanticStorage {
	if os.Getenv("MIRU_FLOAT_VECTORS") == "1" || os.Getenv("SEMBLE_FLOAT_VECTORS") == "1" {
		return SemanticFloat32
	}
	return SemanticInt8
}

func SemanticStorageFromMetadata(metadata map[string]any) SemanticStorage {
	if metadata["vector_storage"] == "float32" {
		return SemanticFloat32
	}
	return SemanticInt8
}

func BuildSemanticIndex(vectors [][]float32) SemanticIndex {
	if ResolveSemanticStorage() == SemanticInt8 {
		return NewQuantizedVectorIndex(vectors)
	}
	return NewVectorIndex(vectors)
}

func SemanticStorageOf(index SemanticIndex) SemanticStorage {
	if _, ok := index.(*QuantizedVectorIndex); ok {
		return SemanticInt8
	}
	return SemanticFloat32
}
