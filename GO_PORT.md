# Go Port Status

Branch: `go-port`

## Implemented

- Standard-library Go module in `go.mod`.
- `cmd/miru` entry point with help, MCP default mode, `search`, `find-related`, `setup`, `install`, `uninstall`, `init`, and `clear`.
- Public Go API in `miru.go` with `MiruIndex`, local path indexing, HTTPS/local source dispatch, Git clone indexing, cache save/load, search, and find-related.
- Deterministic core packages:
  - `internal/tokens`: identifier splitting and tokenization.
  - `internal/chunking`: line chunking, structural chunking, and source chunk metadata.
  - `internal/index`: file discovery, content typing, top-k selection, dense vectors, int8 quantized vectors, persistence, and BM25.
  - `internal/cache`: cache folder/path resolution and cache clearing.
  - `internal/utils`: result formatting, content resolution, Git URL checks, and chunk lookup.
- `internal/embeddings`: OpenAI-compatible embedding client, batching/window pooling, sanitization, and setup validation.
- `internal/credentials` and `internal/envfiles`: stored credentials and `.env` loading.
- `internal/search`: hybrid semantic/BM25 search, RRF fusion, query boosts, and path penalties.
- `internal/git`: shallow Git clone with optional ref and timeout.
- `internal/mcp`: minimal dependency-free stdio MCP server for `search` and `find_related`.
- `internal/installer`: MCP config mutation, marked instruction blocks, Codex TOML blocks, sub-agent install/remove, and agent target paths.
- Go tests mirroring the TypeScript tests for the implemented deterministic modules.
- `scripts/test-parity.sh` to run `bun test` and `go test ./...` together.

## Not Yet Ported

- Installer/uninstaller interactive multi-select UX. The Go CLI currently applies/removes all known targets deterministically.
- Incremental file-change updates and MCP filesystem watching.
- Full `.gitignore` parity: the Go walker has a conservative built-in matcher, not the full npm `ignore` behavior.
- Full TypeScript CLI UI styling/spinner parity.
- Full MCP SDK feature parity beyond `initialize`, `tools/list`, and `tools/call`.

## Current Verification

These passed in this workspace:

```sh
scripts/test-parity.sh
```

The command ran the TypeScript baseline (`82 pass`) and `go test ./...`.

## Parity Command

Run this from the repository root in an environment with both Bun and Go installed:

```sh
scripts/test-parity.sh
```
