package embeddings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/takara-ai/miru-code/internal/env"
)

const (
	defaultModel         = "ds1-potion-code-16m"
	defaultBaseURL       = "https://infer.dev.takara.ai/v1"
	defaultBatchSize     = 32
	defaultMaxEmbedChars = 1300
	windowOverlapChars   = 120
)

var modelDefaultDimensions = map[string]int{
	"ds1-potion-code-16m": 256,
}

type Backend interface {
	ModelName() string
	Dimensions() int
	EmbedDocuments(texts []string) ([][]float32, error)
	EmbedQuery(text string) ([]float32, error)
}

type TransportStats struct {
	Requests        int
	Retries         int
	PayloadTooLarge int
	Errors          int
	InputItems      int
	InputChars      int
	TotalRTTMS      float64
	MaxRTTMS        float64
}

func ResolveEmbeddingModel() string {
	return env.FirstString([]string{"MIRU_OPENAI_EMBEDDING_MODEL", "SEMBLE_OPENAI_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"}, defaultModel)
}

func ResolveMaxEmbedChars() int {
	if value, ok := env.OptionalInt([]string{"MIRU_MAX_EMBED_CHARS", "SEMBLE_MAX_EMBED_CHARS"}, 256); ok {
		return value
	}
	return defaultMaxEmbedChars
}

func ResolveEmbeddingDimensions(model ...string) (int, bool) {
	if value, ok := env.OptionalInt([]string{"MIRU_EMBEDDING_DIMENSIONS", "SEMBLE_EMBEDDING_DIMENSIONS", "OPENAI_EMBEDDING_DIMENSIONS"}); ok {
		return value, true
	}
	resolved := ResolveEmbeddingModel()
	if len(model) > 0 && model[0] != "" {
		resolved = model[0]
	}
	value, ok := modelDefaultDimensions[resolved]
	return value, ok
}

func ResolveEmbeddingBatchSize() int {
	if value, ok := env.OptionalInt([]string{"MIRU_EMBEDDING_BATCH_SIZE", "SEMBLE_EMBEDDING_BATCH_SIZE", "OPENAI_EMBEDDING_BATCH_SIZE"}); ok {
		return value
	}
	return defaultBatchSize
}

func ResolveEmbeddingBaseURL() string {
	return strings.TrimRight(env.FirstString([]string{"MIRU_OPENAI_BASE_URL", "SEMBLE_OPENAI_BASE_URL", "OPENAI_BASE_URL"}, defaultBaseURL), "/")
}

func SanitizeEmbeddingInput(text string) string {
	out := strings.ToValidUTF8(text, "\uFFFD")
	mode := os.Getenv("MIRU_EMBED_ESCAPE_MODE")
	if mode == "" {
		mode = os.Getenv("SEMBLE_EMBED_ESCAPE_MODE")
	}
	if mode == "" {
		mode = "quad"
	}
	if mode == "strip" {
		return strings.ReplaceAll(out, "\\", "/")
	}
	return strings.ReplaceAll(out, "\\", "\\\\\\\\")
}

type Client interface {
	CreateEmbeddings(input []string, model string, dimensions *int) (EmbeddingResponse, error)
}

type EmbeddingResponseItem struct {
	Index     int       `json:"index"`
	Embedding []float64 `json:"embedding"`
}

type EmbeddingResponse struct {
	Data []EmbeddingResponseItem `json:"data"`
}

type APIError struct {
	Status int
	Body   string
}

func (e APIError) Error() string {
	body := e.Body
	if len(body) > 500 {
		body = body[:500]
	}
	return fmt.Sprintf("Embedding API error %d: %s", e.Status, body)
}

type HTTPClient struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
}

func NewHTTPClient() (*HTTPClient, error) {
	key, err := env.ResolveEmbeddingAPIKey()
	if err != nil {
		return nil, err
	}
	return &HTTPClient{
		APIKey:     key,
		BaseURL:    ResolveEmbeddingBaseURL(),
		HTTPClient: http.DefaultClient,
	}, nil
}

func (c *HTTPClient) CreateEmbeddings(input []string, model string, dimensions *int) (EmbeddingResponse, error) {
	body := map[string]any{
		"model": model,
		"input": input,
	}
	if dimensions != nil {
		body["dimensions"] = *dimensions
	}
	data, err := json.Marshal(body)
	if err != nil {
		return EmbeddingResponse{}, err
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/embeddings", bytes.NewReader(data))
	if err != nil {
		return EmbeddingResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")

	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return EmbeddingResponse{}, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return EmbeddingResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return EmbeddingResponse{}, APIError{Status: resp.StatusCode, Body: string(raw)}
	}

	var payload EmbeddingResponse
	if err := json.Unmarshal(raw, &payload); err != nil {
		return EmbeddingResponse{}, err
	}
	if payload.Data == nil {
		return EmbeddingResponse{}, fmt.Errorf("Embedding API returned invalid payload")
	}
	return payload, nil
}

type OpenAIBackend struct {
	model               string
	dimensions          int
	client              Client
	batchSize           int
	maxEmbedChars       int
	requestedDimensions *int
	stats               TransportStats
}

type Options struct {
	Model      string
	BatchSize  int
	MaxChars   int
	Dimensions *int
	Client     Client
}

func NewOpenAIBackend(options Options) (*OpenAIBackend, error) {
	model := options.Model
	if model == "" {
		model = ResolveEmbeddingModel()
	}
	client := options.Client
	var err error
	if client == nil {
		client, err = NewHTTPClient()
		if err != nil {
			return nil, err
		}
	}
	batchSize := options.BatchSize
	if batchSize == 0 {
		batchSize = ResolveEmbeddingBatchSize()
	}
	maxChars := options.MaxChars
	if maxChars == 0 {
		maxChars = ResolveMaxEmbedChars()
	}
	dimensions := options.Dimensions
	if dimensions == nil {
		if value, ok := ResolveEmbeddingDimensions(model); ok {
			copy := value
			dimensions = &copy
		}
	}
	return &OpenAIBackend{
		model:               model,
		client:              client,
		batchSize:           batchSize,
		maxEmbedChars:       maxChars,
		requestedDimensions: dimensions,
	}, nil
}

func (b *OpenAIBackend) ModelName() string {
	return b.model
}

func (b *OpenAIBackend) Dimensions() int {
	return b.dimensions
}

func (b *OpenAIBackend) EmbedDocuments(texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	type windowJob struct {
		docIndex int
		text     string
	}

	jobs := []windowJob{}
	windowVectors := make([][][]float32, len(texts))
	for docIndex, text := range texts {
		for _, window := range splitIntoWindows(text, b.maxEmbedChars) {
			jobs = append(jobs, windowJob{docIndex: docIndex, text: SanitizeEmbeddingInput(window)})
		}
	}
	if len(jobs) == 0 {
		return make([][]float32, len(texts)), nil
	}

	for i := 0; i < len(jobs); i += b.batchSize {
		end := i + b.batchSize
		if end > len(jobs) {
			end = len(jobs)
		}
		batch := jobs[i:end]
		input := make([]string, len(batch))
		for j, job := range batch {
			input[j] = job.text
		}
		vectors, err := b.embedBatchRawWithRetry(input)
		if err != nil {
			return nil, err
		}
		for j, job := range batch {
			if j < len(vectors) {
				windowVectors[job.docIndex] = append(windowVectors[job.docIndex], vectors[j])
			}
		}
	}

	out := make([][]float32, len(texts))
	for i, vectors := range windowVectors {
		pooled, err := poolWindowVectors(vectors)
		if err != nil {
			return nil, err
		}
		if b.dimensions == 0 && len(pooled) > 0 {
			b.dimensions = len(pooled)
		}
		out[i] = pooled
	}
	return out, nil
}

func (b *OpenAIBackend) EmbedQuery(text string) ([]float32, error) {
	vectors, err := b.EmbedDocuments([]string{text})
	if err != nil {
		return nil, err
	}
	if len(vectors) == 0 {
		return nil, fmt.Errorf("OpenAI returned no embedding for query")
	}
	return vectors[0], nil
}

func (b *OpenAIBackend) Stats() TransportStats {
	return b.stats
}

func (b *OpenAIBackend) ResetStats() {
	b.stats = TransportStats{}
}

func (b *OpenAIBackend) embedBatchRawWithRetry(texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	started := time.Now()
	response, err := b.client.CreateEmbeddings(texts, b.model, b.requestedDimensions)
	if err == nil {
		elapsed := float64(time.Since(started).Microseconds()) / 1000
		b.stats.Requests++
		b.stats.InputItems += len(texts)
		for _, text := range texts {
			b.stats.InputChars += utf8.RuneCountInString(text)
		}
		b.stats.TotalRTTMS += elapsed
		if elapsed > b.stats.MaxRTTMS {
			b.stats.MaxRTTMS = elapsed
		}
		vectors, err := vectorsFromResponse(response.Data, len(texts))
		if err != nil {
			b.stats.Errors++
			return nil, err
		}
		for _, vec := range vectors {
			if b.requestedDimensions != nil && len(vec) != *b.requestedDimensions {
				return nil, fmt.Errorf("Embedding API returned %d dims for model %s, expected %d", len(vec), b.model, *b.requestedDimensions)
			}
			if b.dimensions == 0 {
				b.dimensions = len(vec)
			} else if len(vec) != b.dimensions {
				return nil, fmt.Errorf("Inconsistent embedding dimensions in batch: %d vs %d", len(vec), b.dimensions)
			}
		}
		return vectors, nil
	}

	if isPayloadTooLargeError(err) && len(texts) > 1 {
		b.stats.PayloadTooLarge++
		b.stats.Retries++
		mid := (len(texts) + 1) / 2
		left, leftErr := b.embedBatchRawWithRetry(texts[:mid])
		if leftErr != nil {
			return nil, leftErr
		}
		right, rightErr := b.embedBatchRawWithRetry(texts[mid:])
		if rightErr != nil {
			return nil, rightErr
		}
		return append(left, right...), nil
	}
	if isPayloadTooLargeError(err) && len(texts) == 1 {
		b.stats.PayloadTooLarge++
		b.stats.Retries++
		text := texts[0]
		if len(text) <= 128 {
			b.stats.Errors++
			return nil, err
		}
		mid := len(text) / 2
		left, leftErr := b.embedBatchRawWithRetry([]string{text[:mid]})
		if leftErr != nil {
			return nil, leftErr
		}
		right, rightErr := b.embedBatchRawWithRetry([]string{text[mid:]})
		if rightErr != nil {
			return nil, rightErr
		}
		return append(left, right...), nil
	}
	b.stats.Errors++
	return nil, err
}

func splitIntoWindows(text string, maxChars int) []string {
	if len(text) <= maxChars {
		return []string{text}
	}
	out := []string{}
	step := max(64, maxChars-windowOverlapChars)
	for start := 0; start < len(text); start += step {
		end := min(len(text), start+maxChars)
		part := text[start:end]
		if len(part) > 0 {
			out = append(out, part)
		}
		if end >= len(text) {
			break
		}
	}
	return out
}

func isPayloadTooLargeError(err error) bool {
	if apiErr, ok := err.(APIError); ok && apiErr.Status == http.StatusRequestEntityTooLarge {
		return true
	}
	return strings.Contains(err.Error(), "413")
}

func vectorsFromResponse(data []EmbeddingResponseItem, expected int) ([][]float32, error) {
	byIndex := map[int][]float32{}
	for _, item := range data {
		if item.Index >= 0 && item.Index < expected {
			vec := make([]float32, len(item.Embedding))
			for i, value := range item.Embedding {
				vec[i] = float32(value)
			}
			byIndex[item.Index] = vec
		}
	}
	if len(byIndex) != expected {
		return nil, fmt.Errorf("Embedding API returned %d vectors for %d inputs (%d unique indices)", len(data), expected, len(byIndex))
	}
	out := make([][]float32, expected)
	for i := 0; i < expected; i++ {
		vec, ok := byIndex[i]
		if !ok {
			return nil, fmt.Errorf("Missing embedding vector at index %d", i)
		}
		out[i] = vec
	}
	return out, nil
}

func poolWindowVectors(vectors [][]float32) ([]float32, error) {
	if len(vectors) == 0 {
		return nil, fmt.Errorf("Embedding API returned no vectors")
	}
	if len(vectors) == 1 {
		return normalize(vectors[0]), nil
	}
	pooled := make([]float32, len(vectors[0]))
	for _, vec := range vectors {
		for i := range pooled {
			if i < len(vec) {
				pooled[i] += vec[i]
			}
		}
	}
	for i := range pooled {
		pooled[i] /= float32(len(vectors))
	}
	return normalize(pooled), nil
}

func normalize(vec []float32) []float32 {
	var norm float64
	for _, value := range vec {
		norm += float64(value) * float64(value)
	}
	norm = math.Sqrt(norm)
	if norm == 0 {
		return vec
	}
	out := make([]float32, len(vec))
	for i, value := range vec {
		out[i] = float32(float64(value) / norm)
	}
	return out
}
