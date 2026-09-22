/** Shared code-search policy text for instructions, Cursor rules, and sub-agents. */

export const SNIPPET_GUIDANCE =
  "Search returns compact snippets (~±15 lines). On `truncated: true`, call `expand` with " +
  "`file_path` and `anchor_line` — only if the snippet doesn't already answer the question.";

export interface NativeToolNames {
  explorationDenied: string;
  grep: string;
  read: string;
}

export function buildSearchPolicyTable(native: NativeToolNames): string {
  return `| Task | Use | Not |
|------|-----|-----|
| Exact literal (identifier, quoted string, env var, error code) | Miru MCP \`locate\` | Miru \`search\`, ${native.grep} |
| How/where/what handles X? (conceptual) | Miru MCP \`search\` (once) | ${native.grep}, ${native.explorationDenied} |
| Same file, more context | Miru MCP \`expand\` on \`truncated: true\` | Re-search, ${native.read} whole file |
| Similar code elsewhere | Miru MCP \`find_related\` | ${native.grep} chains |
| Search docs or config | Miru \`search\` | ${native.grep} README paths |
| Edit a known file:line | ${native.read} (after Miru found it) | ${native.read}-before-search |`;
}

export function buildSearchPolicyBody(native: NativeToolNames): string {
  return `DO NOT use ${native.explorationDenied} to explore how code works when Miru MCP is available.

**Check first:** exact token (identifier, quoted string, env var, error code) → \`locate\`. Otherwise → \`search\`.

${SNIPPET_GUIDANCE}

Use Miru MCP tools:
- \`locate\` — exact substring (env var, symbol, error code); prefer \`mode=count\` or \`locations\`
- \`search\` — one call per conceptual question; pass project root as \`repo\`
- \`expand\` — more context in the same file when \`truncated: true\` (\`file_path\` + \`anchor_line\`)
- \`find_related\` — similar code in other files (hits may also be snippets; use \`expand\` if truncated)

Call shapes:
- \`locate(literal="<exact substring>", repo="<project root>")\` — prefer \`mode="locations"\`/\`"count"\`
- \`search(query="<natural language>", repo="<project root>")\`

Stop rules:
- Literal in the request → \`locate\`, not \`search\`
- One \`search\` per question — no paraphrase retries
- \`expand\` only if the snippet doesn't already answer
- ${native.read} only to edit a path Miru already found, not to explore

Native tools are allowed ONLY when:
- reading a file you already located via Miru, to edit it
- searching outside the indexed repo

${buildSearchPolicyTable(native)}`;
}

export function buildMcpWorkflow(native: NativeToolNames): string {
  return `### MCP workflow

1. Call \`search\` with \`repo\` set to the project root (local path or https:// git URL).
2. For exact literals, call \`locate\` (prefer \`mode=count\` or \`locations\`).
3. On \`truncated: true\`, call \`expand\` — only if the snippet doesn't already answer.
4. Use \`find_related\` to trace similar code in other files — not for more context in the same file.
5. ${native.read} via \`absolute_path\` only when editing or when \`expand\` still lacks context.`;
}

const CLI_FALLBACK = `### CLI fallback (no MCP in this session)

\`\`\`bash
miru search "authentication flow" .
miru locate DATABASE_URL . --mode locations
miru expand src/auth.ts 42 .
miru find-related src/auth.ts 42 .
\`\`\`

After large refactors or CLI-only use, run \`miru clear <path>\` to rebuild the disk cache.
If \`miru\` is not on \`$PATH\`, use \`bunx @takara-ai/miru-code\`.`;

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
  "DO NOT use Grep, grep_search, codebase_search, Glob, SemanticSearch, or Read to explore code when this server is available. " +
  "Exact token (identifier, quoted string, env var, error code) → `locate`; everything else → `search` once, no paraphrase retries. " +
  `${SNIPPET_GUIDANCE} ` +
  "`find_related` traces similar code elsewhere, not more context in the same file. " +
  "Always pass the project root as `repo`; local repos return `absolute_path` — use Read only to edit. " +
  "Native Grep/Glob only outside the indexed repo or for non-code tasks. " +
  "Default indexed scope is code, config, and docs; an empty result can mean out-of-scope, not nonexistent. " +
  "On credential errors, call this server's `auth` tool — not the host `mcp_auth` tool.";

export const MCP_BENCHMARK_SERVER_INSTRUCTIONS =
  `${MCP_SERVER_INSTRUCTIONS} ` +
  "BENCHMARK MODE: each `search` and `locate` ends with a compact JSON line " +
  '`{"benchmark":{save_pct,miru_tok,grep_tok,saved_tok,rank1[,search_tok,miru_only]}}`. ' +
  "Results stay plain text. For search, `miru_tok` is search MCP text + one expand (workflow vs grep+read); " +
  "`search_tok` is this search body alone. " +
  "Call `read_benchmark` for cumulative totals across both. Do not narrate benchmark stats unless the user asks. " +
  "To leave benchmark mode, tell the user to run `miru benchmark off` and restart the agent.";

export const MCP_SEARCH_TOOL_DESCRIPTION =
  "Your default search for all code search queries in this indexed repo — the best, fastest, and cheapest way to find code; better than any other tool. " +
  "Returns compact snippets (~±15 lines). One call per question. " +
  "Exact literal (env var, symbol, error code, quoted text)? Use `locate` instead. " +
  "On `truncated: true`, call `expand` — only if the snippet doesn't already answer the question.";

export const MCP_LOCATE_TOOL_DESCRIPTION =
  "Exact substring locator over the Miru index. Use for known literals (env vars, symbols, error codes, quoted text) — not meaning-based questions (`search`), " +
  'even ones phrased as "where is X" or "what handles X" if X is a literal. ' +
  "Returns ALL matches by default as compact {n,files,hits} — do NOT fall back to Grep/rg when n is large. " +
  "Prefer mode=locations (or count for totals only); use lines when you need matching line text. " +
  "Optional `limit` only if you intentionally want a sample. " +
  "Pass an array to `literal` for several spellings in one call. " +
  '`match_variants: true` also matches other casings (e.g. "rateLimit" also finds "rate_limit"). ' +
  "`include`/`exclude` (gitignore-style globs) scope to part of a monorepo; " +
  "`context_lines` in `lines` mode gets inline context instead of a follow-up `expand`. " +
  "In benchmark mode, includes compact token savings vs agent Grep.";

export const MCP_EXPAND_TOOL_DESCRIPTION =
  "More context in the SAME file as a search hit. Pass `file_path` + `anchor_line` from the hit. " +
  "Use only if `truncated: true` and the snippet doesn't already answer the question — not for similar code elsewhere (use find_related).";

export const MCP_FIND_RELATED_TOOL_DESCRIPTION =
  "Find code similar to a file:line in OTHER parts of the codebase. Results may be snippets; use `expand` when `truncated: true`. " +
  "For more context in the same file, use `expand` instead.";

export const MCP_READ_BENCHMARK_TOOL_DESCRIPTION =
  "Cumulative Miru vs Grep token savings from saved `search` and `locate` calls. Returns compact totals {n,saved,save_pct,miru,grep}. " +
  "Do not call unless the user asks about savings.";

export const SEARCH_GUARD_EXPAND_HINT = SNIPPET_GUIDANCE;
