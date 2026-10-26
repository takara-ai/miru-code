# Always-on residual ranking

CLI and MCP code search using `ds1-miru-int8` returns four distinct files by
default. Every compatible query uses the same learned scorer, including symbols,
paths, short lookups and non-ASCII text. There is no query routing. Explicit library
`topK` requests remain explicit; the library's existing default remains ten.

The bundled 191,207-byte CPU tree ensemble adds a bounded correction to the
existing int8 + BM25 ranking. Symbol/definition boosts and path penalties remain
part of the prior. It requires no extra embedding, network inference, model
download or accelerator. Int8 vector storage is unchanged.

`MIRU_RESIDUAL_TOP4=0` restores five CLI/MCP results while keeping learned ranking.
`MIRU_RESIDUAL_RANK_MODEL=0` disables the scorer and restores the original serving
budget. A JSON path overrides the bundled model. Explicit `rerank=false`, prose-only
indexes, foreign embedding models and incompatible ranking overrides retain their
base ranking behavior. Restart an existing process to load updated code.

## Model contract

The bundled `residual-v2` model uses 60 float32 features: 44 retrieval, lexical,
path and definition features plus 16 boosted-prior and Unicode overlap features.
Definition features share production symbol detection and boost tiers. Unicode
terms use NFKC normalization and Unicode letter/number boundaries. Parsed feature
caches are bounded independently of corpus size.

The model has 200 trees with at most 15 leaves per tree. A correction strength of
0.5 is incorporated into exported leaf values; the final correction is clipped to
[-3, 3]. The best scored chunk represents each file. Retrieval uses the same
minimum candidate depth of ten regardless of the output cutoff, so top4 is the
prefix of top5. Symbol queries retain their existing fusion weight of 0.3.

Export SHA256: `601c3e5e595fe34d43c170218d276ec6249d557a0d9bbeab4936ff5b4d553c53`.
Native model SHA256: `9663cf1eb469bf5ac3646762d844a1991661411806251384c9449fd28f2722d4`.
The test suite pins the export checksum and checks numeric predictions against
native LightGBM reference outputs. Experimental retrained models are not bundled.

## Evaluation and accepted cutoff tradeoff

Coverage means the fraction of queries returning at least one annotated relevant
file. These results compare the original int8 + BM25 top5 baseline with this exact
model at both output budgets. All query types use the model in both reranked arms.

| Heldout benchmark | Queries | Original top5 coverage | Reranked top5 | Reranked top4 |
|---|---:|---:|---:|---:|
| Unified code QA sample | 122,684 | 72.002% | 77.541% | 76.056% |
| RepoQA repositories | 310 | 50.000% | 62.258% | 60.645% |
| Semble repositories | 779 | 96.406% | 97.561% | 95.635% |

On the QA sample, first-result accuracy improves from 57.124% to 63.862% with
either reranked budget. Top4 improves coverage over baseline by 4.054 percentage
points (paired cluster 95% CI +3.534 to +4.573). Actual formatted snippet responses
average 740.55 baseline tokens versus 524.81 at top4: a 29.132% saving (CI
28.583–29.681%) on a deterministic 6,231-query token sample.

Across the 1,089 heldout repository queries, top4 improves coverage from 83.196%
to 85.675%, and first-result accuracy from 59.780% to 65.106%. Source-backed
formatted responses average 592.39 baseline tokens versus 518.12 at top4, saving
12.54% (CI 11.00–14.08%). The Semble subset loses six net covered queries versus
baseline, or 0.770 percentage points (CI -1.823 to +0.282). Compared with reranked
top5, dropping the fifth result loses 15 covered Semble queries. Semble target-file
recall changes from 92.918% at baseline to 91.955% at top4.

Four is the accepted default tradeoff: broad coverage/ranking gains and lower token
use, with the small observed Semble coverage loss disclosed. Top5 is available
through the global opt-out. No query-specific exception is introduced.

The QA evaluation uses a heldout sample from the two-million-row cached campaign,
not the full approximately 92-million-row dataset. It searches bounded source/
language pools of snippets, whereas Semble and RepoQA use real repository indexes.
The QA result therefore does not establish equivalent gains for every repository
workflow. Labels are incomplete, most QA paths lack original repository metadata,
and rare languages have limited or absent heldout evidence.

## Provenance and verification

Dataset: `takarajordan/code-qa-unified-full`, pinned at
`5df877d62da26a9ad84a5c47552bbc389530400b`.

[Training job](https://huggingface.co/jobs/takarajordan/6adb2604925af0e27d4fcf44)
fit 77,054 queries, with 17,647 development queries. Repository-aware hash splits
exclude heldout query/relevance supervision; existing repository benchmark splits
override the hash split. The 1,089 heldout repository queries are excluded from
fitting. The model was frozen before the
[122,684-query QA evaluation](https://huggingface.co/jobs/takarajordan/6adb3380c191903149a7dadd),
covering 164 corpora and 708 repository/corpus clusters. These historical datasets
were examined during earlier research; heldout means excluded from this fit and
selection, not unseen throughout the research campaign. Document overlap and
near-duplicate dependence are not fully eliminated.

The source-backed serving replay covers all 1,840 repository queries, verifying
9,385,380 float32 feature values, ordered scores and top4/top5 prefix equality.
All 1,000 exported test predictions matched native LightGBM with zero observed
error. Local ranking-only latency averaged 5.46 ms (p95 15.73 ms), excluding
embedding and retrieval; this is not a production latency guarantee.

Release verification on 2026-10-26 passed 840 tests on Linux, macOS and Windows,
plus typecheck, lint and plugin-skill sync. The Linux CI coverage result is 98.1%
(the local macOS run reported 99.6%). The cached repository replay again verified
all 1,840 queries and 9,385,380 feature values with top4 enabled by default. The
packaged tarball contains the exact evaluated model and its serving dependencies.

Private recovery artifacts remain in `takarajordan/miru-reranker-cache`:

- Encoded inputs: `scale-2m-20261022-v1/0dee6b7667eb1911`.
- Numeric training caches: `always-on-ranker-20261023-v1/8b15f5d47b9ebce7`.
- Heldout checkpoints: `always-on-heldout-20261023-v1/e29096e245c8fc23`.
- Final model, reports, parity and frozen evaluation plan:
  `always-on-final-20261023/601c3e5e595fe34d`.

Archives and individual members have SHA256 checksums. Training and evaluation
reused encoded caches and used CPU jobs; no new paid job is needed to enable this
already evaluated model and cutoff.
