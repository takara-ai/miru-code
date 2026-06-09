package index

import "math"

const (
	bm25K1 = 1.5
	bm25B  = 0.75
)

type Posting struct {
	DocIndex int
	Count    int
}

type BM25Index struct {
	docFreq      map[string]int
	docLengths   []int
	postings     map[string][]Posting
	avgDocLength float64
	numDocs      int
}

func NewBM25Index() *BM25Index {
	return &BM25Index{
		docFreq:  map[string]int{},
		postings: map[string][]Posting{},
	}
}

func (b *BM25Index) Index(tokenizedDocs [][]string) {
	b.numDocs = len(tokenizedDocs)
	b.docFreq = map[string]int{}
	b.docLengths = nil
	b.postings = map[string][]Posting{}

	totalLen := 0
	for docIndex, doc := range tokenizedDocs {
		b.docLengths = append(b.docLengths, len(doc))
		totalLen += len(doc)

		tf := map[string]int{}
		for _, term := range doc {
			tf[term]++
		}
		for term, count := range tf {
			b.docFreq[term]++
			b.postings[term] = append(b.postings[term], Posting{DocIndex: docIndex, Count: count})
		}
	}

	if b.numDocs > 0 {
		b.avgDocLength = float64(totalLen) / float64(b.numDocs)
	} else {
		b.avgDocLength = 0
	}
}

func (b *BM25Index) GetScores(queryTokens []string, weightMask ...[]bool) []float64 {
	scores := make([]float64, b.numDocs)
	if b.numDocs == 0 || len(queryTokens) == 0 {
		return scores
	}

	terms := b.queryTerms(queryTokens)
	avg := b.avgDocLength
	if avg == 0 {
		avg = 1
	}

	var mask []bool
	if len(weightMask) > 0 {
		mask = weightMask[0]
	}

	for _, term := range terms {
		list := b.postings[term.Term]
		for _, posting := range list {
			docIndex := posting.DocIndex
			if mask != nil && (docIndex >= len(mask) || !mask[docIndex]) {
				continue
			}
			if docIndex >= len(b.docLengths) {
				continue
			}
			tf := float64(posting.Count)
			dl := float64(b.docLengths[docIndex])
			denom := tf + bm25K1*(1-bm25B+(bm25B*dl)/avg)
			scores[docIndex] += term.IDF * ((tf * (bm25K1 + 1)) / denom)
		}
	}

	return scores
}

func (b *BM25Index) GetScoresAsync(queryTokens []string, weightMask ...[]bool) []float64 {
	return b.GetScores(queryTokens, weightMask...)
}

type BM25Term struct {
	Term string
	IDF  float64
}

func (b *BM25Index) queryTerms(queryTokens []string) []BM25Term {
	seen := map[string]bool{}
	terms := []BM25Term{}
	for _, token := range queryTokens {
		if seen[token] {
			continue
		}
		seen[token] = true
		df := b.docFreq[token]
		if df == 0 {
			continue
		}
		idf := math.Log(1 + (float64(b.numDocs)-float64(df)+0.5)/(float64(df)+0.5))
		terms = append(terms, BM25Term{Term: token, IDF: idf})
	}
	return terms
}

type BM25JSON struct {
	Postings     map[string][][2]int `json:"postings"`
	DocLengths   []int               `json:"docLengths"`
	AvgDocLength float64             `json:"avgDocLength"`
	NumDocs      int                 `json:"numDocs"`
}

func (b *BM25Index) ToJSON() BM25JSON {
	postings := map[string][][2]int{}
	for term, list := range b.postings {
		out := make([][2]int, len(list))
		for i, posting := range list {
			out[i] = [2]int{posting.DocIndex, posting.Count}
		}
		postings[term] = out
	}
	return BM25JSON{
		Postings:     postings,
		DocLengths:   append([]int(nil), b.docLengths...),
		AvgDocLength: b.avgDocLength,
		NumDocs:      b.numDocs,
	}
}

func BM25FromJSON(data BM25JSON) *BM25Index {
	idx := NewBM25Index()
	idx.docLengths = append([]int(nil), data.DocLengths...)
	idx.avgDocLength = data.AvgDocLength
	idx.numDocs = data.NumDocs
	for term, list := range data.Postings {
		postings := make([]Posting, len(list))
		for i, pair := range list {
			postings[i] = Posting{DocIndex: pair[0], Count: pair[1]}
		}
		idx.postings[term] = postings
		idx.docFreq[term] = len(postings)
	}
	return idx
}
