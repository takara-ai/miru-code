package embeddings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type ValidateResult struct {
	Valid   bool
	Status  int
	Message string
}

func ValidateAPIKey(apiKey string, baseURL string, model string, dimensions *int) ValidateResult {
	if baseURL == "" {
		baseURL = ResolveEmbeddingBaseURL()
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if model == "" {
		model = ResolveEmbeddingModel()
	}
	if dimensions == nil {
		if value, ok := ResolveEmbeddingDimensions(model); ok {
			dimensions = &value
		}
	}
	body := map[string]any{
		"model": model,
		"input": "miru setup validation",
	}
	if dimensions != nil {
		body["dimensions"] = *dimensions
	}
	data, err := json.Marshal(body)
	if err != nil {
		return ValidateResult{Valid: false, Message: err.Error()}
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/embeddings", bytes.NewReader(data))
	if err != nil {
		return ValidateResult{Valid: false, Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ValidateResult{Valid: false, Message: fmt.Sprintf("Could not reach embedding API at %s: %s", baseURL, err.Error())}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return ValidateResult{Valid: false, Status: resp.StatusCode, Message: "Invalid API key (authentication failed)."}
		}
		text := string(raw)
		if len(text) > 200 {
			text = text[:200]
		}
		return ValidateResult{Valid: false, Status: resp.StatusCode, Message: fmt.Sprintf("Embedding API returned %d: %s", resp.StatusCode, text)}
	}
	var payload struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ValidateResult{Valid: false, Status: resp.StatusCode, Message: "Embedding API returned invalid JSON."}
	}
	if len(payload.Data) == 0 || len(payload.Data[0].Embedding) == 0 {
		return ValidateResult{Valid: false, Status: resp.StatusCode, Message: "Embedding API returned an empty response."}
	}
	if dimensions != nil && len(payload.Data[0].Embedding) != *dimensions {
		return ValidateResult{Valid: false, Status: resp.StatusCode, Message: fmt.Sprintf("Expected %d embedding dimensions, got %d.", *dimensions, len(payload.Data[0].Embedding))}
	}
	return ValidateResult{Valid: true, Status: resp.StatusCode, Message: "API key is valid."}
}
