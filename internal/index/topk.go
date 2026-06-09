package index

import "sort"

type TopKDistanceEntry struct {
	Index    int
	Distance float64
}

func SelectTopKByDistance(entries []TopKDistanceEntry, k int) []TopKDistanceEntry {
	top := []TopKDistanceEntry{}
	for _, entry := range entries {
		if len(top) < k {
			top = append(top, entry)
			sort.Slice(top, func(i, j int) bool { return top[i].Distance > top[j].Distance })
			continue
		}
		if len(top) > 0 && entry.Distance < top[0].Distance {
			top[0] = entry
			sort.Slice(top, func(i, j int) bool { return top[i].Distance > top[j].Distance })
		}
	}
	sort.Slice(top, func(i, j int) bool { return top[i].Distance < top[j].Distance })
	return top
}

func SelectTopKScoreIndices(scores []float64, k int) []int {
	if k <= 0 || len(scores) == 0 {
		return nil
	}

	type scoreEntry struct {
		value float64
		index int
	}
	top := []scoreEntry{}
	for i, score := range scores {
		if len(top) < k {
			top = append(top, scoreEntry{value: score, index: i})
			sort.Slice(top, func(i, j int) bool { return top[i].value < top[j].value })
			continue
		}
		if len(top) > 0 && score > top[0].value {
			top[0] = scoreEntry{value: score, index: i}
			sort.Slice(top, func(i, j int) bool { return top[i].value < top[j].value })
		}
	}
	sort.Slice(top, func(i, j int) bool { return top[i].value > top[j].value })
	out := make([]int, len(top))
	for i, entry := range top {
		out[i] = entry.index
	}
	return out
}
