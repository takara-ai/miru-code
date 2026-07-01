# Changelog

## [1.1.0](https://github.com/takara-ai/miru-code/compare/v1.0.5...v1.1.0) (2026-07-01)


### Features

* **cli:** add interactive brand banner and centralize defaults ([ca1c0ea](https://github.com/takara-ai/miru-code/commit/ca1c0ea71f00672113216691f850d038500cef86))


### Bug Fixes

* **mcp:** accept anchor_line and start_line on expand and find_related ([fd17b44](https://github.com/takara-ai/miru-code/commit/fd17b44767840b976d0198a0e91308d3b368072f))
* **mcp:** rename expand and find_related line param to anchor_line ([b228515](https://github.com/takara-ai/miru-code/commit/b22851509d9aca361b5281449cfb5ba23082e68c))
* **mcp:** rename expand and find_related line param to anchor_line ([0e06e8c](https://github.com/takara-ai/miru-code/commit/0e06e8c0bc018df6b40414e9e044f4e3ee6b354f))


### Performance Improvements

* **index:** flat vector storage, heap top-k, and unrolled int8 dot ([cbb6248](https://github.com/takara-ai/miru-code/commit/cbb6248483882c0ae88d64e21b02f99b19da3827))

## [1.0.5](https://github.com/takara-ai/miru-code/compare/v1.0.4...v1.0.5) (2026-06-25)


### Bug Fixes

* **cli:** prompt install after first-time setup ([e8c650b](https://github.com/takara-ai/miru-code/commit/e8c650b9db7fcf904f3dc98246c852fe624ec266))
* **mcp:** position search as default for all code queries ([a74d221](https://github.com/takara-ai/miru-code/commit/a74d221c3e5704ffd5f78a08d942489f6b49ec01))

## [1.0.4](https://github.com/takara-ai/miru-code/compare/v1.0.3...v1.0.4) (2026-06-23)


### Bug Fixes

* **mcp:** replace SDK with Bun-native stdio server ([8ad3380](https://github.com/takara-ai/miru-code/commit/8ad33807f3b0f76a47c8451dae5ca5cccfc06e24))

## 1.0.0 (2026-06-23)


### ⚠ BREAKING CHANGES

* remove legacy SEMBLE_* env var aliases
* improve CLI and require TAKARA_API_KEY (v0.3.0)
* **mcp:** MCP tools require repo on every call. Remove optional startup path indexing; agents must pass the project root explicitly.

### Features

* add credentials setup, incremental indexing, and IDE docs (v0.1.4) ([a19f321](https://github.com/takara-ai/miru-code/commit/a19f32168b54ba635b3ca28fd00bc17007237142))
* add interactive installer and polished CLI (v0.4.0) ([d679e36](https://github.com/takara-ai/miru-code/commit/d679e3629bd218f9ba2b22878b500d62728cc8cc))
* auto-prompt API key and simplify README (v0.4.2) ([993a9fa](https://github.com/takara-ai/miru-code/commit/993a9fa05487a2a81f0e2b1baa89c5e757ffb9ed))
* C++ chunking, MCP credentials, and GitHub search (v0.4.5) ([06e31e5](https://github.com/takara-ai/miru-code/commit/06e31e59667c00432a6540c3842dce2fa7060726))
* **chunking:** wire tree-sitter AST chunking with vendored wasm grammars ([fcba598](https://github.com/takara-ai/miru-code/commit/fcba598b4875e7a87b217f6163816c52b23f5d22))
* **cli:** add -v flag and daily npm update check ([febf9b1](https://github.com/takara-ai/miru-code/commit/febf9b105378ec796c755e718bba1be83c8ca628))
* **embeddings:** default ds1-miru-int8 with int8 dequantization ([7b97672](https://github.com/takara-ai/miru-code/commit/7b97672ac003806b593d190eeefd57ce5ac1e1d1))
* improve CLI and require TAKARA_API_KEY (v0.3.0) ([4f1b5f2](https://github.com/takara-ai/miru-code/commit/4f1b5f221bac992ae083295a33c1e3438e4a309e))
* **installer:** mark search hooks experimental and opt-in ([878038e](https://github.com/takara-ai/miru-code/commit/878038ef2f73b9f83b8a2c1bc13abb66db19897b))
* **mcp:** defer indexing until first search with required repo ([f62e815](https://github.com/takara-ai/miru-code/commit/f62e8155aa5dd75c3cef7efb62734c9bf7946edf))
* search hooks, snippets, and ranking improvements (v0.5.0) ([34ab3db](https://github.com/takara-ai/miru-code/commit/34ab3db9a0dcc73cd6d7d15b9841a827a5445ec9))


### Bug Fixes

* **embeddings:** pool single-input HTTP 413 splits into one vector ([3ba54af](https://github.com/takara-ai/miru-code/commit/3ba54af85122068716a7ceb8502e6321272d6004))
* **embeddings:** preserve backslashes in embedding input by default ([a664c72](https://github.com/takara-ai/miru-code/commit/a664c726871ac2f07abd95204b9c26ef3db12daa))
* **embeddings:** retry transient API errors with exponential backoff ([1db91c5](https://github.com/takara-ai/miru-code/commit/1db91c53e96f0ec248a83273f795be5ef4470731))
* **embeddings:** strip lone surrogates before API JSON (v0.1.3) ([2b9abec](https://github.com/takara-ai/miru-code/commit/2b9abecd83f9ef3786d5d6e606993c21e078ba0a))
* **index:** add workspace scope and per-index file budget guardrails ([257fb49](https://github.com/takara-ai/miru-code/commit/257fb490a30155559ba9bd48e721aae18f7b67a6))
* **index:** track file read errors separately from empty skips ([cc8b110](https://github.com/takara-ai/miru-code/commit/cc8b11092eedadbbb9cd5d05008a256113561649))
* **mcp:** handle null fs.watch filenames and stabilize watcher test ([247cbd7](https://github.com/takara-ai/miru-code/commit/247cbd73049ea5c24e08e168f6da7e98497bf31a))
* **mcp:** keep per-repo file watchers in IndexCache ([e153034](https://github.com/takara-ai/miru-code/commit/e153034c6fe990444d93f6fd2707ad43390247be))
* **mcp:** reject plain http:// git URLs unless explicitly opted in ([91e780d](https://github.com/takara-ai/miru-code/commit/91e780dac11664f55ac86001311d024f4563e5f4))
* **mcp:** report package version in server handshake ([3268b9d](https://github.com/takara-ai/miru-code/commit/3268b9d660c12f3d6464dafc57f57b9f2ed06401))
* **mcp:** stop memory growth from unbounded re-indexing (v0.1.2) ([b42c3f6](https://github.com/takara-ai/miru-code/commit/b42c3f6f862942e56a1720e715f303167f5f3c2e))
* remove bun npm dep so MCP/bun x works (v0.1.1) ([64e7bea](https://github.com/takara-ai/miru-code/commit/64e7beaf4f88f455a7a87f1129481f1ad35c6b02))
* **test:** cast IndexCache internals without intersecting private methods ([2076ea2](https://github.com/takara-ai/miru-code/commit/2076ea29fea809400938d58caa51b05ba1a9fb3a))


### Code Refactoring

* remove legacy SEMBLE_* env var aliases ([ac9f011](https://github.com/takara-ai/miru-code/commit/ac9f011860f326901bd941513434b0c12d4b0480))
