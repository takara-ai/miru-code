package index

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

var defaultIgnoredDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true, "__pycache__": true, "node_modules": true,
	".venv": true, "venv": true, ".tox": true, ".mypy_cache": true, ".pytest_cache": true,
	".ruff_cache": true, ".cache": true, ".miru": true, ".next": true, "dist": true,
	"build": true, ".eggs": true,
}

type ignoreSpec struct {
	base     string
	patterns []string
}

func WalkFiles(root string, extensions []string) ([]string, error) {
	extSet := map[string]bool{}
	for _, ext := range extensions {
		extSet[strings.ToLower(ext)] = true
	}

	files := []string{}
	err := walkFiles(root, extSet, nil, &files)
	return files, err
}

func walkFiles(dir string, extSet map[string]bool, inherited []ignoreSpec, files *[]string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	active := inherited
	if spec := loadIgnoreForDir(dir); len(spec.patterns) > 0 {
		active = append(append([]ignoreSpec(nil), inherited...), spec)
	}

	for _, entry := range entries {
		fullPath := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if defaultIgnoredDirs[entry.Name()] || isIgnoredBySpecs(fullPath, true, active) {
				continue
			}
			if err := walkFiles(fullPath, extSet, active, files); err != nil {
				return err
			}
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if isIgnoredBySpecs(fullPath, false, active) {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if strings.EqualFold(entry.Name(), "dockerfile") || extSet[ext] {
			*files = append(*files, fullPath)
		}
	}
	return nil
}

func loadIgnoreForDir(directory string) ignoreSpec {
	spec := ignoreSpec{base: directory}
	for _, name := range []string{".gitignore", ".miruignore"} {
		file, err := os.Open(filepath.Join(directory, name))
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
				continue
			}
			spec.patterns = append(spec.patterns, line)
		}
		file.Close()
	}
	return spec
}

func isIgnoredBySpecs(fullPath string, isDir bool, specs []ignoreSpec) bool {
	for _, spec := range specs {
		rel, err := filepath.Rel(spec.base, fullPath)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		rel = filepath.ToSlash(rel)
		if isDir {
			rel += "/"
		}
		for _, pattern := range spec.patterns {
			if matchesIgnorePattern(rel, pattern) {
				return true
			}
		}
	}
	return false
}

func matchesIgnorePattern(rel, pattern string) bool {
	pattern = strings.TrimSpace(strings.ReplaceAll(pattern, "\\", "/"))
	if pattern == "" {
		return false
	}
	if strings.HasSuffix(pattern, "/") {
		return strings.HasPrefix(rel, strings.TrimSuffix(pattern, "/")+"/")
	}
	if strings.Contains(pattern, "/") {
		ok, _ := filepath.Match(pattern, rel)
		return ok || rel == pattern || strings.HasPrefix(rel, pattern+"/")
	}
	base := filepath.Base(strings.TrimSuffix(rel, "/"))
	ok, _ := filepath.Match(pattern, base)
	return ok || base == pattern || strings.Contains(rel, "/"+pattern+"/")
}
