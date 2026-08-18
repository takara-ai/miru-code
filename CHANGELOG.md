# Changelog

## [1.7.3](https://github.com/takara-ai/miru-code/compare/v1.7.2...v1.7.3) (2026-08-18)


### Bug Fixes

* **release:** publish from trusted workflow ([1e93b66](https://github.com/takara-ai/miru-code/commit/1e93b667ba540cb058969840d80cc3b3ff1d0ddb))
* **release:** publish from trusted workflow ([5168211](https://github.com/takara-ai/miru-code/commit/5168211b36f9d5ac9a5fc6f4dd75d35c7bd76c92))

## [1.7.2](https://github.com/takara-ai/miru-code/compare/v1.7.1...v1.7.2) (2026-08-18)


### Bug Fixes

* **release:** allow generated plugin manifests ([77b56cc](https://github.com/takara-ai/miru-code/commit/77b56ccc6cef53990823255fe5bf5cbf2b8073a2))

## [1.7.1](https://github.com/takara-ai/miru-code/compare/v1.7.0...v1.7.1) (2026-08-18)


### Bug Fixes

* **plugin:** format release manifests ([40a779a](https://github.com/takara-ai/miru-code/commit/40a779a37a7277edb783a4de338b981df0693c00))

## [1.7.0](https://github.com/takara-ai/miru-code/compare/v1.6.0...v1.7.0) (2026-08-18)


### Features

* **installer:** add experimental STE on-demand skill (ref PRD-405) ([d82a2b9](https://github.com/takara-ai/miru-code/commit/d82a2b9e5b050d9988e2bddf298f2264e567596c))
* **installer:** enable Caveman skill on all Miru IDEs (ref PRD-404) ([1d6176c](https://github.com/takara-ai/miru-code/commit/1d6176c49e5f45f71bbfe7eb1f41e7b4e73096e8))
* **installer:** enable STE skill on all Miru IDEs (ref PRD-405) ([14e68ed](https://github.com/takara-ai/miru-code/commit/14e68edbe09bfca69d6c1fdf6d929e78f63802d5))
* **installer:** enable STE skill on all Miru IDEs (ref PRD-405) ([61fa3cf](https://github.com/takara-ai/miru-code/commit/61fa3cf7b935aeda8e00ce3c1edbc8127e2c16f3))
* **installer:** install Caveman to shared ~/.agents/skills ([de1cd28](https://github.com/takara-ai/miru-code/commit/de1cd287147237e96378440f849d464208fc40eb))


### Bug Fixes

* **auth:** recover expired device credentials in MCP ([725725c](https://github.com/takara-ai/miru-code/commit/725725c5027de5e98b79cbf6f475e90807b2b4c9))
* **auth:** skip device-login confirm on interactive setup ([f3d25c3](https://github.com/takara-ai/miru-code/commit/f3d25c30177ea1171884ebc9652d051c65ada915))
* **auth:** start device login spinner immediately ([59729b7](https://github.com/takara-ai/miru-code/commit/59729b73d26dc8b76d835a687e00eacddcd7be8e))
* **ci:** satisfy biome on spinner width and prompt imports ([caf885d](https://github.com/takara-ai/miru-code/commit/caf885d23445f656b9affea3a76ebb1a1f8b2cfc))
* **cli:** map confirm arrows to Yes/No layout ([3655eeb](https://github.com/takara-ai/miru-code/commit/3655eeb440ec226f4fb5be59e601fd298873e1b8))
* **cli:** nest help under miru &lt;command&gt; -h ([3380255](https://github.com/takara-ai/miru-code/commit/3380255a187df8951277c25a7e2bf4743b052081))
* **installer:** align STE with Caveman shared-path ownership (ref PRD-405) ([339de86](https://github.com/takara-ai/miru-code/commit/339de8621955295bf951a4cbff31a2eecdfb33e2))
* **installer:** harden Caveman shared-path ownership and clean up ([3e66f34](https://github.com/takara-ai/miru-code/commit/3e66f34cac2108b8c47f875ef151156abca82f36))
* **installer:** preserve user STE files ([fd838b3](https://github.com/takara-ai/miru-code/commit/fd838b3d5a3070f8b610702cf93a53c860848c6a))
* **plugin:** keep marketplace on main until release ([6633121](https://github.com/takara-ai/miru-code/commit/66331210acece6f6ab52bebeba65f453903c1e64))
* **plugin:** pin Codex marketplace to npm release ([853f8bc](https://github.com/takara-ai/miru-code/commit/853f8bc62486557314023bf2b049293ecc856edf))
* **plugin:** run Miru from npm latest ([b06b47e](https://github.com/takara-ai/miru-code/commit/b06b47ea7257e1683af19d67503d0d4755b4e592))
* **plugin:** use takara.ai publisher name ([c55866f](https://github.com/takara-ai/miru-code/commit/c55866f52aaa33803678795e0c74d6f5bb14e3be))
* **release:** preserve unprefixed version tags ([0f3f9dc](https://github.com/takara-ai/miru-code/commit/0f3f9dc3b399849586df9bff52d74842e593cea8))
* **release:** publish manifest releases ([1379889](https://github.com/takara-ai/miru-code/commit/1379889a50073169b13a7abecdcb2f2e67be5350))

## [1.6.0](https://github.com/takara-ai/miru-code/compare/v1.5.3...v1.6.0) (2026-08-12)


### Features

* **installer:** add experimental Caveman on-demand skill (ref PRD-404) ([5d7296e](https://github.com/takara-ai/miru-code/commit/5d7296e2a621a243645489762c8fedee8ed7a9ef))
* **installer:** add experimental Caveman on-demand skill (ref PRD-404) ([03c77d3](https://github.com/takara-ai/miru-code/commit/03c77d3889b5514c914d5326a44edc5aa6dae9ef))
* **mcp:** add auth tool for headless device-code login ([f3417a8](https://github.com/takara-ai/miru-code/commit/f3417a890b78d460d45e794a88f3641c9d112a01))
* **mcp:** add auth tool for headless device-code login ([f97c90e](https://github.com/takara-ai/miru-code/commit/f97c90e3c0e2f38f78c4eec252bf7a4116d922a5))


### Bug Fixes

* **auth:** keep device credential failures from bricking CLI and MCP ([5b97a9f](https://github.com/takara-ai/miru-code/commit/5b97a9f6191eee1d0f4152508680b069845e7a1f))
* **ci:** use Bun-native prepare for prek hooks on Windows ([0c4d74c](https://github.com/takara-ai/miru-code/commit/0c4d74c55cd50d81e828b3cd136c1733a6034868))
* **ci:** use Bun-native prepare for prek hooks on Windows ([db19aa8](https://github.com/takara-ai/miru-code/commit/db19aa8ab0401862e899f22e12368cd4811b9911))
* **installer:** drop hardcoded PATH from Kiro MCP config ([9e93d0f](https://github.com/takara-ai/miru-code/commit/9e93d0f50c9745b4423423440dad10eadfb856b2))
* **installer:** drop STE cross-reference from Caveman copy (ref PRD-404) ([6076276](https://github.com/takara-ai/miru-code/commit/6076276cf4062bfe2cc26eb539b3cb018c388173))
* **installer:** only offer integrations supported by selected agents ([a6c5b3d](https://github.com/takara-ai/miru-code/commit/a6c5b3dd792137edc9ff65c01492834cb62851b4))
* **installer:** remove premature STE section from Caveman skill (ref PRD-404) ([afe07cd](https://github.com/takara-ai/miru-code/commit/afe07cda8ac4e69f4ef9ba8b721410e6d9b6e690))
* **mcp:** run credential check non-interactive for headless stdio server ([f403243](https://github.com/takara-ai/miru-code/commit/f4032434093f11b3fae7a7099dc8c0dbd629f856))
* **test:** assert caveman skill paths with path.join ([afa9cc2](https://github.com/takara-ai/miru-code/commit/afa9cc2eeed81ccf132c67a46b1b4e8d045db028))
* **test:** keep MCP cold-start stdin open until replies arrive ([b223624](https://github.com/takara-ai/miru-code/commit/b2236247eb53255d7dad3ce8a4943e574adb6a38))

## [1.5.3](https://github.com/takara-ai/miru-code/compare/v1.5.2...v1.5.3) (2026-08-01)


### Bug Fixes

* **setup:** clear opposing mode before Takara/SageMaker cutover ([8c82716](https://github.com/takara-ai/miru-code/commit/8c8271628d3cd8b977b555a534f61a847b4b01c0))
* **setup:** type fetch mock params in validate API key test ([62b17ed](https://github.com/takara-ai/miru-code/commit/62b17edccc001be401e29b9389c724b5653bc8f7))

## [1.5.2](https://github.com/takara-ai/miru-code/compare/v1.5.1...v1.5.2) (2026-08-01)


### Bug Fixes

* **windows:** use Bun for benchmark spawn timeout tests ([185aca2](https://github.com/takara-ai/miru-code/commit/185aca2669d18114c44cec7da7996ffadfcf4303))

## [1.5.1](https://github.com/takara-ai/miru-code/compare/v1.5.0...v1.5.1) (2026-08-01)


### Bug Fixes

* **benchmark:** timeout hung rg/grep baseline spawns ([db35cc2](https://github.com/takara-ai/miru-code/commit/db35cc26d1c4865b9cd7c2592f2e72a6255fafd0))
* **credentials:** cut over cleanly between Takara and SageMaker ([6a6fc64](https://github.com/takara-ai/miru-code/commit/6a6fc64834cbc36b4f3d3d2341faba784bf2f90a))

## [1.5.0](https://github.com/takara-ai/miru-code/compare/v1.4.0...v1.5.0) (2026-07-23)


### Features

* **embeddings:** add self-hosted AWS SageMaker embedding backend ([a4a357f](https://github.com/takara-ai/miru-code/commit/a4a357fa190d547a01b4c52d539a3f943b649bb6))
* **embeddings:** add self-hosted AWS SageMaker embedding backend ([6f2ca78](https://github.com/takara-ai/miru-code/commit/6f2ca7863056323d21ea2859c38a0baa8f80aa8e))
* **setup:** make Takara and SageMaker credentials mutually exclusive ([7861a8b](https://github.com/takara-ai/miru-code/commit/7861a8b16af8d78a944e6b857f235d65d992d476))


### Bug Fixes

* **embeddings:** replace unauthorized body with actionable auth message ([d264915](https://github.com/takara-ai/miru-code/commit/d26491578b46c6677ab30e807784c99e30f1f0fd))
* **types:** correct SageMaker InvokeEndpoint and setup test typing ([c762b59](https://github.com/takara-ai/miru-code/commit/c762b59cc4f4c85a264d8df016f1db2c4a56a177))


### Performance Improvements

* **embeddings:** lazy-load SageMaker AWS SDK until first invoke ([67ddbff](https://github.com/takara-ai/miru-code/commit/67ddbff69ca9b6bd8cc5a9e8a4db56bef8728ff6))
* **index:** fill embedding API batches and overlap BM25 during indexing ([f4f7201](https://github.com/takara-ai/miru-code/commit/f4f720119a0ac6e56985a39d308ce88821736668))

## [1.4.0](https://github.com/takara-ai/miru-code/compare/v1.3.1...v1.4.0) (2026-07-16)


### Features

* **mcp:** render tool results as plain text instead of JSON ([d5c661c](https://github.com/takara-ai/miru-code/commit/d5c661c336e8eca2ba5c9b4bef20b912bae23e38))


### Bug Fixes

* **benchmark:** count MCP plaintext bodies and return text in benchmark mode ([2c80972](https://github.com/takara-ai/miru-code/commit/2c80972188a94741b1e10bd7d8d8a222f822a764))

## [1.3.1](https://github.com/takara-ai/miru-code/compare/v1.3.0...v1.3.1) (2026-07-16)


### Bug Fixes

* **benchmark:** grep every match_variants/literal-array variant, not just the raw literal ([185a237](https://github.com/takara-ai/miru-code/commit/185a23775aa188339001d9168913967c4167f423))
* **benchmark:** scale grep baseline context to the requested context_lines ([8c88e2f](https://github.com/takara-ai/miru-code/commit/8c88e2f44566994659d140cd40aaea0c222c117a))

## [1.3.0](https://github.com/takara-ai/miru-code/compare/v1.2.2...v1.3.0) (2026-07-16)


### Features

* **locate:** support literal arrays, casing variants, glob scoping, and context lines ([7d50988](https://github.com/takara-ai/miru-code/commit/7d5098889386132417f3315da1b1169bcd2594c3))


### Bug Fixes

* **benchmark:** stop dropping match_variants/include/exclude/context_lines in locate comparison ([6616c31](https://github.com/takara-ai/miru-code/commit/6616c3161ae12be6544dedde5766c552ab1a2a19))

## [1.2.2](https://github.com/takara-ai/miru-code/compare/v1.2.1...v1.2.2) (2026-07-16)


### Bug Fixes

* **installer:** write Claude MCP at root, not nested projects ([b0797a2](https://github.com/takara-ai/miru-code/commit/b0797a29b2d56ab218ec6853620b309f401e6953))

## [1.2.1](https://github.com/takara-ai/miru-code/compare/v1.2.0...v1.2.1) (2026-07-16)


### Bug Fixes

* **benchmark:** fallback to grep/findstr when rg is unavailable ([73abc29](https://github.com/takara-ai/miru-code/commit/73abc29e6d9f9d25b15b4d201fcf8bda48d902bc))
* **benchmark:** harden native fallback and literal parsing ([8e5ec95](https://github.com/takara-ai/miru-code/commit/8e5ec95f420fed14242941471e28ae1a1d2a630c))
* **benchmark:** normalize windows absolute paths in fallback ([d2d0976](https://github.com/takara-ai/miru-code/commit/d2d0976086ea3a920f36e1b292ba839d64325329))
* **benchmark:** parse windows findstr paths correctly ([479e0ec](https://github.com/takara-ai/miru-code/commit/479e0ec9b030f4aecc2b14e272a26bf30ac95eb0))
* **benchmark:** parse windows grep output paths ([9f278f8](https://github.com/takara-ai/miru-code/commit/9f278f805872daf2575053a8e328a93bbe404ef1))
* **test:** make path assertions windows-safe ([f77b461](https://github.com/takara-ai/miru-code/commit/f77b4613f18768820b13d540386724b2cc360269))
* **test:** satisfy import order lint ([bd67ec6](https://github.com/takara-ai/miru-code/commit/bd67ec654abcf50c585dd35d4c948211312b17e7))

## [1.2.0](https://github.com/takara-ai/miru-code/compare/v1.1.0...v1.2.0) (2026-07-16)


### Features

* benchmark mode and locate tool ([c1ba1af](https://github.com/takara-ai/miru-code/commit/c1ba1aff3c9b74156a91d4dc1108071431a6ce0d))
* **benchmark:** add MCP benchmark mode with Hugging Face token counting ([654448c](https://github.com/takara-ai/miru-code/commit/654448c6d83313e085b6ed025095bd7b293237ad))
* **benchmark:** add rollup tool, compact payloads, and mode toggle ([8a2d029](https://github.com/takara-ai/miru-code/commit/8a2d02943dda03ff3a2294fe438b37b1d56f98e3))
* **cli:** set process.title to miru ([461c551](https://github.com/takara-ai/miru-code/commit/461c5517d5492fdf8c51ab3fd8125caefa1f0636))
* **locate:** add exact-literal MCP/CLI tool with Grep token benchmarks ([2321a1e](https://github.com/takara-ai/miru-code/commit/2321a1efc1b5d1383535fc243f012527efa602bf))
* prd 276 index freshness cache invalidation ([a8ce1b3](https://github.com/takara-ai/miru-code/commit/a8ce1b3335d44bc523e3fce689ce1add41d9c442))


### Bug Fixes

* **benchmark:** harden mode persistence and history edge cases ([54be476](https://github.com/takara-ai/miru-code/commit/54be476b901837d68f8b08b0caef6bc44c30c3ea))
* **benchmark:** honor dedupe flag and unify path/expand defaults ([a85215f](https://github.com/takara-ai/miru-code/commit/a85215fa1d5f5f29ee8cf415af45dfa8d506eef9))
* **benchmark:** persist history as append-only JSONL without locks ([82268ef](https://github.com/takara-ai/miru-code/commit/82268efa93a1a24b714cc224a1495167c6ad9f28))
* **installer:** avoid control-character regex in arrow key parser ([361aac3](https://github.com/takara-ai/miru-code/commit/361aac3851304c05635c693cfc1f26fd2a2083a4))
* **installer:** leave experimental search hooks off by default ([21cdf9e](https://github.com/takara-ai/miru-code/commit/21cdf9ecf7ae933f828dd58bf905638896d887d0))
* **installer:** leave search hooks unchecked by default ([9aa82af](https://github.com/takara-ai/miru-code/commit/9aa82af8bf745d3daa46bbae09cc7bac2e4f2452))
* **installer:** support Windows arrow key sequences in prompts ([8fa6b1b](https://github.com/takara-ai/miru-code/commit/8fa6b1bf8959c55ad04d7f0355ef967e28912d88))
* **mcp:** detect new files and close race in index freshness check ([c237898](https://github.com/takara-ai/miru-code/commit/c237898479086ddbad056f2ae0f3b3c26eacbeb6))
* **mcp:** resolve IndexCache self-deadlock during stale reconciliation ([d0d7125](https://github.com/takara-ai/miru-code/commit/d0d712546934e708b8bf37a71cb20c9aaee73e87))
* **security:** add shared ownership tracking for VS Code hook file ([def4152](https://github.com/takara-ai/miru-code/commit/def4152712df5e71d9c119f70c6a3538d21fa9ad))
* **security:** clarify MIRU_WORKSPACE_ROOT as opt-in MCP boundary ([112c5b7](https://github.com/takara-ai/miru-code/commit/112c5b793e48948d245d224822f6b0afccd32914))
* **security:** enable hook guard by default in installer ([524c614](https://github.com/takara-ai/miru-code/commit/524c6140816617a2c3ecabe1c8ab44749430e9e6))
* **security:** preserve JSONC content during installer edits ([04709e5](https://github.com/takara-ai/miru-code/commit/04709e5e1a6cb4bbcd40e1da21f2b1e8aa7dbf46))
* **security:** remove external JSONC parser dependency ([f5dfe35](https://github.com/takara-ai/miru-code/commit/f5dfe356c673f594dd443a695c9dbc05164e664d))

## [1.1.2](https://github.com/takara-ai/miru-code/compare/v1.1.1...v1.1.2) (2026-07-13)


### Bug Fixes

* **mcp:** avoid IndexCache deadlock when reconciling stale files on first search


## [1.1.1](https://github.com/takara-ai/miru-code/compare/v1.1.0...v1.1.1) (2026-07-09)


### Bug Fixes

* **installer:** support Windows arrow key sequences in interactive prompts

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
