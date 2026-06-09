package credentials

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"

	"github.com/takara-ai/miru-code/internal/env"
)

const (
	filename = "credentials.json"
	version  = 1
)

type Stored struct {
	Version      int    `json:"version"`
	TakaraAPIKey string `json:"takara_api_key"`
}

func ResolveDir() string {
	if override := os.Getenv("MIRU_CREDENTIALS_DIR"); override != "" {
		return override
	}
	home := os.Getenv("HOME")
	if home == "" {
		home = os.Getenv("USERPROFILE")
	}
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "miru")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "miru")
	default:
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		return filepath.Join(base, "miru")
	}
}

func ResolvePath() string {
	return filepath.Join(ResolveDir(), filename)
}

func Read() (*Stored, error) {
	data, err := os.ReadFile(ResolvePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var stored Stored
	if err := json.Unmarshal(data, &stored); err != nil {
		return nil, nil
	}
	if stored.Version != version || stored.TakaraAPIKey == "" {
		return nil, nil
	}
	return &stored, nil
}

func Load() (bool, error) {
	if env.HasTakaraAPIKeyInEnv() {
		return false, nil
	}
	stored, err := Read()
	if err != nil || stored == nil {
		return false, err
	}
	os.Setenv(env.TakaraAPIKeyEnv, stored.TakaraAPIKey)
	return true, nil
}

func Save(apiKey string) (string, error) {
	dir := ResolveDir()
	path := ResolvePath()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	payload := Stored{Version: version, TakaraAPIKey: apiKey}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	_ = os.Chmod(path, 0o600)
	return path, nil
}

type ClearResult struct {
	Cleared bool
	Path    string
}

func Clear() (ClearResult, error) {
	path := ResolvePath()
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return ClearResult{Cleared: false, Path: path}, nil
		}
		return ClearResult{}, err
	}
	stored, _ := Read()
	if err := os.Remove(path); err != nil {
		return ClearResult{}, err
	}
	if stored != nil && os.Getenv(env.TakaraAPIKeyEnv) == stored.TakaraAPIKey {
		os.Unsetenv(env.TakaraAPIKeyEnv)
	}
	return ClearResult{Cleared: true, Path: path}, nil
}
