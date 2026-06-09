package index

import (
	"reflect"
	"strconv"
	"testing"
)

func TestBM25RanksMatchingDocumentHigherThanUnrelatedDocument(t *testing.T) {
	idx := NewBM25Index()
	idx.Index([][]string{
		{"auth", "middleware", "token"},
		{"database", "migration", "schema"},
	})
	scores := idx.GetScores([]string{"auth", "token"})
	if scores[0] <= scores[1] {
		t.Fatalf("scores = %#v, want matching document higher", scores)
	}
}

func TestBM25RanksDocumentWithMoreQueryTermsHigher(t *testing.T) {
	idx := NewBM25Index()
	idx.Index([][]string{{"alpha"}, {"alpha", "beta", "gamma"}, {"delta", "epsilon"}})
	scores := idx.GetScores([]string{"alpha", "beta"})
	if scores[1] <= scores[0] || scores[1] <= scores[2] {
		t.Fatalf("scores = %#v, want doc with more query terms higher", scores)
	}
}

func TestBM25ReturnsZeroScoresForUnknownQueryTerms(t *testing.T) {
	idx := NewBM25Index()
	idx.Index([][]string{{"known", "term"}})
	scores := idx.GetScores([]string{"missing", "terms"})
	for _, score := range scores {
		if score != 0 {
			t.Fatalf("scores = %#v, want all zero", scores)
		}
	}
}

func TestBM25RespectsWeightMask(t *testing.T) {
	idx := NewBM25Index()
	idx.Index([][]string{{"auth", "token"}, {"auth", "token", "extra"}})
	masked := idx.GetScores([]string{"auth"}, []bool{false, true})
	if masked[0] != 0 || masked[1] <= 0 {
		t.Fatalf("scores = %#v, want first masked and second positive", masked)
	}
}

func TestBM25GetScoresAsyncMatchesGetScores(t *testing.T) {
	docs := [][]string{}
	for d := 0; d < 300; d++ {
		if d%2 == 0 {
			docs = append(docs, []string{"alpha", "beta", "gamma", "doc" + strconv.Itoa(d)})
		} else {
			docs = append(docs, []string{"delta", "epsilon", "other" + strconv.Itoa(d)})
		}
	}
	idx := NewBM25Index()
	idx.Index(docs)
	query := []string{"alpha", "doc42", "epsilon"}
	if !reflect.DeepEqual(idx.GetScoresAsync(query), idx.GetScores(query)) {
		t.Fatal("GetScoresAsync does not match GetScores")
	}
}

func TestBM25JSONRoundTrip(t *testing.T) {
	idx := NewBM25Index()
	idx.Index([][]string{{"alpha", "alpha"}, {"beta"}})
	loaded := BM25FromJSON(idx.ToJSON())
	if !reflect.DeepEqual(loaded.GetScores([]string{"alpha"}), idx.GetScores([]string{"alpha"})) {
		t.Fatal("BM25 JSON round-trip changed scores")
	}
}
