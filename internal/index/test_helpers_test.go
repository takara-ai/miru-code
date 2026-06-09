package index

import "math"

func seededRandom(seed uint32) func() float64 {
	state := seed
	return func() float64 {
		state = state + 0x6d2b79f5
		t := state
		t = uint32(int32(t^(t>>15)) * int32(t|1))
		t ^= t + uint32(int32(t^(t>>7))*int32(t|61))
		return float64((t^(t>>14))>>0) / 4294967296
	}
}

func normalizedRandom(dim int, rand func() float64) []float32 {
	v := make([]float32, dim)
	for i := 0; i < dim; i++ {
		v[i] = float32(rand()*2 - 1)
	}
	var norm float64
	for _, value := range v {
		norm += float64(value) * float64(value)
	}
	norm = math.Sqrt(norm)
	for i, value := range v {
		v[i] = float32(float64(value) / norm)
	}
	return v
}

func unitVector(dim, activeIndex int, value float32) []float32 {
	v := make([]float32, dim)
	v[activeIndex] = value
	var norm float64
	for _, value := range v {
		norm += float64(value) * float64(value)
	}
	norm = math.Sqrt(norm)
	for i, value := range v {
		v[i] = float32(float64(value) / norm)
	}
	return v
}
