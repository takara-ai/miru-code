package tokens

import (
	"reflect"
	"testing"
)

func TestSplitIdentifierCamelCase(t *testing.T) {
	got := SplitIdentifier("HandlerStack")
	want := []string{"handlerstack", "handler", "stack"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SplitIdentifier() = %#v, want %#v", got, want)
	}
}

func TestSplitIdentifierSnakeCase(t *testing.T) {
	got := SplitIdentifier("my_func")
	want := []string{"my_func", "my", "func"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SplitIdentifier() = %#v, want %#v", got, want)
	}
}

func TestTokenizeExpandsCompounds(t *testing.T) {
	got := Tokenize("getHTTPResponse")
	if !contains(got, "gethttpresponse") || !contains(got, "http") {
		t.Fatalf("Tokenize() = %#v, want compound expansion", got)
	}
}

func TestSplitIdentifierAcronymsAndDigits(t *testing.T) {
	cases := map[string][]string{
		"HTTPResponse": {"httpresponse", "http", "response"},
		"ABC":          {"abc"},
		"parse2HTML":   {"parse2html", "parse", "2", "html"},
	}
	for input, want := range cases {
		if got := SplitIdentifier(input); !reflect.DeepEqual(got, want) {
			t.Fatalf("SplitIdentifier(%q) = %#v, want %#v", input, got, want)
		}
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
