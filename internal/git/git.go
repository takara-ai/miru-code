package git

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/takara-ai/miru-code/internal/env"
)

const defaultCloneTimeoutSec = 60

func CloneRepository(url string, ref *string) (string, error) {
	timeoutSec := defaultCloneTimeoutSec
	if value, ok := env.OptionalInt([]string{"MIRU_CLONE_TIMEOUT", "SEMBLE_CLONE_TIMEOUT"}); ok {
		timeoutSec = value
	}
	dir, err := os.MkdirTemp("", "miru-git-")
	if err != nil {
		return "", err
	}

	args := []string{"clone", "--depth", "1"}
	if ref != nil && *ref != "" {
		args = append(args, "--branch", *ref)
	}
	args = append(args, "--", url, dir)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return "", fmt.Errorf("git is not installed or not on PATH")
	}
	rawErr, _ := io.ReadAll(stderr)
	err = cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		os.RemoveAll(dir)
		return "", fmt.Errorf("git clone timed out for %s (limit: %ds)", url, timeoutSec)
	}
	if err != nil {
		os.RemoveAll(dir)
		return "", fmt.Errorf("git clone failed for %s:\n%s", url, strings.TrimSpace(string(rawErr)))
	}
	return filepath.Clean(dir), nil
}
