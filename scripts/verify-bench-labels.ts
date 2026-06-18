import { clearCache } from "../src/cache.ts";
import { loadStoredCredentials } from "../src/credentials.ts";
import { normalizeTakaraApiKeyEnv } from "../src/env.ts";
import { loadEnvFiles } from "../src/env-files.ts";
import { MiruIndex } from "../src/miru-index.ts";
import { dedupeResultsByFile } from "../src/utils.ts";
import { pathMatches } from "./benchmark-lib.ts";
import { REPO_BENCHES, TOP_K } from "./search-ab-queries.ts";

loadEnvFiles();
normalizeTakaraApiKeyEnv();
await loadStoredCredentials();

const repoFilter = new Set(process.argv.slice(2));
const benches = REPO_BENCHES.filter((b) => repoFilter.size === 0 || repoFilter.has(b.name));

for (const bench of benches) {
  await clearCache(bench.path);
  const index = await MiruIndex.fromPath(bench.path, ["code"]);
  console.log(`\n=== ${bench.name} (${index.chunks.length} chunks) ===\n`);

  for (const spec of bench.queries) {
    const results = dedupeResultsByFile(
      await index.search({ query: spec.query, topK: TOP_K, rerank: true }),
    ).slice(0, TOP_K);

    let relevantFound = 0;
    for (const want of spec.relevant) {
      if (results.some((r) => pathMatches(r.chunk.file_path, want))) {
        relevantFound++;
      }
    }

    console.log(`Q: ${spec.query}`);
    console.log(`Expected (${spec.relevant.length}): ${spec.relevant.join(", ")}`);
    console.log(`Recall@${TOP_K}: ${relevantFound > 0 ? "PASS" : "FAIL"} (${relevantFound}/${spec.relevant.length} files)`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const hits = spec.relevant.filter((want) => pathMatches(r.chunk.file_path, want));
      console.log(
        `  ${i + 1}. ${r.chunk.file_path}:${r.chunk.start_line}-${r.chunk.end_line}${hits.length ? ` [MATCH: ${hits.join(", ")}]` : ""}`,
      );
    }
    console.log("");
  }
}
