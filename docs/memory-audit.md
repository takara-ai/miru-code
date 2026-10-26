# Memory lifecycle audit

The 2026-10-26 audit covers the production int8 + BM25 search pipeline, bundled
residual reranker, MCP sessions, index cache/watchers, BM25 workers and AST parsing.
Experimental local encoders are outside this release's scope.

## Fixed retention and cleanup issues

- A build finishing after eviction or cache reset could restart an orphaned file
  watcher. Builds, reconciliation and queued updates now verify that their exact
  cache entry still owns the work. Reset remains reusable for authentication.
- File-change events arriving during a slow update could accumulate promise
  chains. Changes now coalesce into one drain per entry, with failed changes kept
  for a later retry rather than a busy retry loop.
- MCP EOF and connection failures did not release the index cache. Session cleanup
  now closes watchers, drops indexes and disconnects the transport's message
  handler. Explicit shutdown also cancels an idle stream reader; cleanup runs once.
- Ranking metadata used strong chunk keys, retaining chunks after their owning
  index was discarded. Weak keys now allow collection, including metadata that
  indirectly references its key. Each metadata cache also caps live entries at
  512 chunks, 100,000 token entries and 2,000,000 source UTF-16 code units.
- A synchronous BM25 worker `postMessage` exception could leave its worker alive.
  Send errors, decode errors, worker errors and successful replies now terminate
  workers and detach their handlers.

The regex cache remains bounded at 4,096 symbols. Parser trees and parser instances
already have explicit deletion in `finally` blocks; repeated AST parsing is covered
by the soak. Grammar caching is limited to the shipped grammar paths.

## Reproduce the offline soak

From a repository checkout with dependencies installed:

```sh
bun run test:memory
```

An optional output path can be supplied with `bun scripts/check-memory.ts PATH`.
The script rejects incompatible ranking settings, forbids network/embedding calls,
uses synthetic normalized vectors in an int8 index, and checks that repeated
queries return identical results. Its fixture contains 768 chunks and 64-dimensional
vectors; this exercises ownership and repeated work, not production retrieval quality.

The workload includes:

- 512 warm-up searches plus 4,096 further searches through int8 + BM25 + reranking.
- 144 searches using real BM25 worker threads, including 24 for warm-up.
- 120 index load/eviction/close cycles and watcher accounting with deterministic
  watcher handles. Separate integration tests exercise actual filesystem watchers.
- 1,250 real tree-sitter parses, including 250 for warm-up.
- Weak-reference checks for discarded chunks and indexes, across asynchronous
  turns and forced full garbage collections.

The recorded clean-snapshot run used Bun 1.4.4 on macOS arm64, matching CI's Bun
version. No discarded probe chunks or indexes remained alive; all 120 watcher
handles closed and no more than ten existed at once. Live search heap stayed around
4.9 MB after warm-up. This is the complete JavaScript heap for the small fixture,
not a production memory budget or the reranker's isolated RAM requirement.

The before-fix run retained all 128 discarded probe chunks in ranking metadata;
the fixed run retained zero. The old cache was count-bounded, so this demonstrates
unnecessary retention after index disposal rather than unlimited per-query growth.
The orphan-watcher and connection cleanup failures are also reproduced by regression
tests, including a late build completing after its replacement has started.

The machine-readable observations are in [memory-audit-results.json](memory-audit-results.json).
The soak gates search, worker and index-cycle retained-heap growth at 4 MiB after
warm-up, worker RSS growth at 64 MiB, and AST heap/RSS growth at 4/32 MiB. These are
regression envelopes; they do not imply that growth below a threshold is a leak or
that every workload has been proved leak-free.

## Verification and limits

Regression tests cover weak ownership and cache limits, cache-close/eviction races,
connection failures, reader cancellation, update storms and worker failures. The
full suite, lint and typecheck run on the exact staged release snapshot.
The final local run passed 853 tests with 98.3% source-line coverage on Bun 1.4.4.

The 1,840-query cached repository replay also verifies all 9,385,380 float32 feature
values, scores and result ordering against the evaluated model. These lifecycle
changes preserve top4/top5 prefix equality and the model checksum.

An open session intentionally holds up to ten repository indexes. Memory therefore
depends on repository size even without a leak. Closing a cache drops its ownership;
an external caller holding an index still owns that memory. Already-running build
or embedding work is allowed to settle, but cannot republish itself after eviction.

Forced GC measures reachable objects; RSS can keep allocator or WebAssembly capacity
for reuse. A finite synthetic soak and source audit cannot prove the absence of
every leak in all repositories, operating systems or embedding providers.
