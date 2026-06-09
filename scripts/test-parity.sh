#!/usr/bin/env sh
set -eu

if ! command -v go >/dev/null 2>&1; then
  echo "go is required to run the Go port tests" >&2
  exit 127
fi

if command -v bun >/dev/null 2>&1; then
  bun test
elif command -v npm >/dev/null 2>&1; then
  npm exec --yes bun -- test
else
  echo "bun or npm is required to run the TypeScript parity baseline" >&2
  exit 127
fi

go test ./...
