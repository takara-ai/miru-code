/** Shared code-search policy text for instructions, Cursor rules, and sub-agents. */

export const SNIPPET_GUIDANCE =
  "Snippets show up to 5 numbered source lines around a match by default. A `truncated: true` hit gives the matched file range (`path:start-end`) and `anchor_line`. " +
  "For more context, read just that range (`offset`/`limit`); use `expand` (`file_path` + `anchor_line`) for neighbouring chunks.";

export const WHEN_TO_REACH_FOR_MIRU =
  "Reach for Miru FIRST, before opening files, whenever you don't know the exact path: starting in unfamiliar code, " +
  "finding where to edit, how/where/why questions, tracing callers or similar code, docs/config. " +
  "`locate` also does regex (`/re/`) and lists files by name (`include` globs, no literal). " +
  "Grep/Glob only for files Miru does not index (lockfiles, binaries, generated or git-ignored).";

export interface NativeToolNames {
  explorationDenied: string;
  grep: string;
  read: string;
}

export function buildSearchPolicyTable(native: NativeToolNames): string {
  return `| Task | Use | Not |
|------|-----|-----|
| Exact literal (identifier, quoted string, env var, error code) | Miru MCP \`locate\` | Miru \`search\`, ${native.grep} |
| Regex over code | Miru MCP \`locate\` with \`/regex/\` (\`mode=files\` for paths only) | ${native.grep} |
| List files by name pattern | Miru MCP \`locate\` with \`include\` globs and no literal | Glob |
| How/where/what handles X? (conceptual) | Miru MCP \`search\` (once) | ${native.grep}, ${native.explorationDenied} |
| More context for a \`truncated: true\` hit | ${native.read} the hit's \`start-end\` lines (\`offset\`/\`limit\`) | Re-search, ${native.read} whole file |
| Same file, neighbouring chunks | Miru MCP \`expand\` (fallback) | Re-search |
| Similar code elsewhere | Miru MCP \`find_related\` | ${native.grep} chains |
| Search docs or config | Miru \`search\` | ${native.grep} README paths |
| Edit a known file:line | ${native.read} the hit's \`start-end\` lines (after Miru found it) | ${native.read}-before-search |`;
}

export function buildSearchPolicyBody(native: NativeToolNames): string {
  return `DO NOT use ${native.explorationDenied} to explore how code works when Miru MCP is available.

${WHEN_TO_REACH_FOR_MIRU}

**Check first:** exact token (identifier, quoted string, env var, error code) → \`locate\`. Otherwise → \`search\`.

${SNIPPET_GUIDANCE}

\`repo\` is optional, set it for another repo.

Use Miru MCP tools:
- \`locate\` — exact substring (env var, symbol, error code) or \`/regex/\`; no literal + \`include\` globs lists files; prefer \`mode=count\`, \`files\` or \`locations\`
- \`search\` — one call per conceptual question; use \`include\` / \`exclude\` Gitignore-style globs to scope files (same syntax as \`locate\`)
- \`expand\` — fallback: neighbouring chunks in the same file around \`anchor_line\` (\`file_path\` + \`anchor_line\`)
- \`find_related\` — similar code in other files (hits may also be snippets; read the hit's lines if truncated)

Call shapes:
- \`locate(literal="<exact substring>")\` — prefer \`mode="locations"\`/\`"count"\`
- \`search(query="<natural language>", include=["src/auth/**"])\` — use the same \`include\` / \`exclude\` globs on \`locate\` when scoping an exact-string search

Stop rules:
- Literal in the request → \`locate\`, not \`search\`
- One \`search\` per question — no paraphrase retries
- On \`truncated: true\`, ${native.read} only the hit's \`start-end\` lines (\`offset\`/\`limit\`); \`expand\` only if that doesn't answer
- ${native.read} only a path Miru already found, to see a truncated body or edit it — never to explore, never the whole file

Native tools are allowed ONLY when:
- reading a file you already located via Miru, to edit it
- searching outside the indexed repo
- files Miru does not index (lockfiles, binaries, generated or git-ignored files)

${buildSearchPolicyTable(native)}`;
}

export function buildMcpWorkflow(native: NativeToolNames): string {
  return `### MCP workflow

1. Call \`search\`; add \`repo\` only for another repo.
2. For exact literals, call \`locate\` (prefer \`mode=count\` or \`locations\`).
3. On \`truncated: true\`, ${native.read} the hit's \`start-end\` lines (\`offset\`/\`limit\`) — only if the snippet doesn't already answer.
4. Use \`expand\` for neighbouring chunks if that range lacks context; \`find_related\` to trace similar code in other files.
5. ${native.read} via \`absolute_path\` only for the hit's range, to see a truncated body or edit it.`;
}

const CLI_FALLBACK = `### CLI fallback (no MCP in this session)

\`\`\`bash
miru search "authentication flow" .
miru locate DATABASE_URL . --mode locations
miru expand src/auth.ts 42 .
miru find-related src/auth.ts 42 .
\`\`\`

After large refactors or CLI-only use, run \`miru clear <path>\` to rebuild the disk cache.
If \`miru\` is not on \`$PATH\`, use \`bunx @takara-ai/miru-code@latest\`.`;

export function buildSubagentBody(native: NativeToolNames): string {
  return `When Miru MCP is available, use MCP \`search\`, \`locate\`, \`expand\`, and \`find_related\` — not ${native.explorationDenied} for exploration.

${buildSearchPolicyBody(native)}

${buildMcpWorkflow(native)}

${CLI_FALLBACK}`;
}

export const DEFAULT_NATIVE_TOOLS: NativeToolNames = {
  explorationDenied: "Grep, Glob, SemanticSearch, or Read",
  grep: "Grep",
  read: "Read",
};

export const SEARCH_POLICY_BODY = buildSearchPolicyBody(DEFAULT_NATIVE_TOOLS);

export const INSTRUCTIONS_MARKDOWN = `## Miru Code Search

${SEARCH_POLICY_BODY}

Run \`miru setup\` once — the MCP server loads credentials from \`credentials.json\`, and interactive first use can auto-start device login when nothing is stored.

${CLI_FALLBACK}`;

export const CURSOR_RULES_MDC = `---
description: Miru MCP is the default for all code exploration
alwaysApply: true
---

# Code search policy (Miru)

${SEARCH_POLICY_BODY}

When Miru MCP is connected: literal in the request → \`locate\`, not Grep or \`search\`. Otherwise \`search\` once. \`expand\` only if the snippet doesn't already answer. Never use Cursor SemanticSearch for codebase questions.`;

export const SUBAGENT_BODY = buildSubagentBody(DEFAULT_NATIVE_TOOLS);

export const MCP_SERVER_INSTRUCTIONS =
  "Miru `search` is your default for all code search queries in indexed repos — the best, fastest, and cheapest way to find code; better than any other tool. " +
  `${WHEN_TO_REACH_FOR_MIRU} ` +
  "DO NOT use Grep, grep_search, codebase_search, Glob, SemanticSearch, or Read to explore code while this server is available. " +
  "Exact token (identifier, quoted string, env var, error code) → `locate`; everything else → `search` once, no paraphrase retries. " +
  `${SNIPPET_GUIDANCE} ` +
  "`find_related` finds similar code elsewhere. " +
  "`repo` is optional (other repos). " +
  "Indexed scope is code, config, and docs; an empty result can mean out-of-scope, not nonexistent. " +
  "On credential errors, call this server's `auth` tool, not the host `mcp_auth`.";

export const MCP_BENCHMARK_SERVER_INSTRUCTIONS =
  `${MCP_SERVER_INSTRUCTIONS} ` +
  "BENCHMARK MODE: each `search` and `locate` ends with a compact JSON line " +
  '`{"benchmark":{save_pct,miru_tok,grep_tok,saved_tok,rank1[,search_tok,miru_only]}}`. ' +
  "Results stay plain text. For search, `miru_tok` is search MCP text + one expand (workflow vs grep+read); " +
  "`search_tok` is this search body alone. " +
  "Call `read_benchmark` for cumulative totals across both. Do not narrate benchmark stats unless the user asks. " +
  "To leave benchmark mode, tell the user to run `miru benchmark off` and restart the agent.";

export const MCP_SEARCH_TOOL_DESCRIPTION =
  "Semantic codebase search: find code by meaning (where/how/what handles X, callers, related code, docs, config) instead of grepping or reading files. Use FIRST when you don't know the exact path. " +
  "Your default search for all code search queries in this indexed repo — the best, fastest, and cheapest way to find code; better than any other tool. " +
  "Up to 5 numbered excerpts (±2 lines by default), one call per question; exact literals → `locate`. " +
  "On `truncated: true`, `expand` only if the snippet doesn't already answer.";

export const MCP_LOCATE_TOOL_DESCRIPTION =
  "Exact substring locator over the Miru index, also `/regex/` and file lists (grep for identifiers, env vars, error strings, quoted text, without the noise). " +
  'Use for known literals, not meaning-based questions (`search`), even when phrased "where is X" if X is a literal. ' +
  "A literal wrapped in slashes is always a regex (`/foo\\w+Bar/`, `/bench/i`); omit the slashes for plain text. No literal + `include` globs lists files by name pattern; mode=files returns just matching paths. " +
  "Returns ALL matches by default — do NOT fall back to Grep/rg when n is large; prefer mode=count/files/locations unless you need line text. " +
  "`context_lines` (mode=lines) saves a follow-up `expand`. In benchmark mode, includes token savings vs Grep.";

export const MCP_EXPAND_TOOL_DESCRIPTION =
  "Neighbouring chunks in the SAME file as a search hit (`file_path` + `anchor_line` from the hit). " +
  "For a `truncated: true` hit's matched range, read its `start-end` lines instead; use this only if that doesn't answer — not for similar code elsewhere (use find_related).";

export const MCP_FIND_RELATED_TOOL_DESCRIPTION =
  "Find up to 5 chunks similar to a file:line in OTHER parts of the codebase. Results may be snippets; use `expand` when `truncated: true`. " +
  "For more context in the same file, use `expand` instead.";

export const MCP_READ_BENCHMARK_TOOL_DESCRIPTION =
  "Cumulative Miru vs Grep token savings from saved `search` and `locate` calls. Returns compact totals {n,saved,save_pct,miru,grep}. " +
  "Do not call unless the user asks about savings.";
