package envfiles

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

func Load(packageRoot, cwd string) {
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}
	for _, dir := range []string{packageRoot, cwd} {
		if dir == "" {
			continue
		}
		loadFile(filepath.Join(dir, ".env.local"))
		loadFile(filepath.Join(dir, ".env"))
	}
}

func loadFile(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		applyLine(scanner.Text())
	}
}

func applyLine(line string) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return
	}
	eq := strings.Index(trimmed, "=")
	if eq == -1 {
		return
	}
	key := strings.TrimSpace(trimmed[:eq])
	if key == "" {
		return
	}
	if _, exists := os.LookupEnv(key); exists {
		return
	}
	value := strings.TrimSpace(trimmed[eq+1:])
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
	}
	os.Setenv(key, value)
}
