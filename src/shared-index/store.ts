import type { SQL } from "bun";
import type { EmbeddingBackend } from "../embeddings/openai.ts";
import { enrichForBm25 } from "../index/sparse.ts";
import { tokenize } from "../tokens.ts";
import {
  type FileUpdate,
  type GitState,
  type GitSync,
  type Identity,
  type PreparedChange,
  type SharedCandidates,
  SharedIndexError,
  sharedContentHash,
} from "./protocol.ts";

const DIMENSIONS = 256;
const CANDIDATES_PER_REPOSITORY = 32;
const EMPTY_GIT_STATE: GitState = { completed: null, active: null };

type FileState = { revision: string; content_hash: string | null };
type Candidate = SharedCandidates["candidates"][number];
type SearchQuery = { query: string; repositories: string[] };

function vectorLiteral(vector: Float32Array): string {
  if (vector.length !== DIMENSIONS || !vector.every(Number.isFinite) || !vector.some(Boolean)) {
    throw new SharedIndexError(502, "Embedding provider returned an incompatible ds1-code vector.");
  }
  return JSON.stringify(Array.from(vector));
}

function contentState(
  existing: FileState | undefined,
  change: PreparedChange,
  hash: string | null,
) {
  if (existing?.revision === change.revision) {
    if (existing.content_hash !== hash) {
      throw new SharedIndexError(409, "This file revision already has different content.");
    }
    return "unchanged";
  }
  if ((existing?.revision ?? null) !== change.previousRevision) {
    throw new SharedIndexError(
      409,
      "The file revision changed. Read the current revision and retry.",
    );
  }
  return existing?.content_hash === hash ? "metadata" : "replace";
}

async function retryTransaction<T>(db: SQL, work: (tx: SQL) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.begin(work);
    } catch (error) {
      if (databaseErrorCode(error) !== "40001" || attempt >= 4) throw error;
      await Bun.sleep(10 * 2 ** attempt + Math.random() * 10);
    }
  }
}

export function databaseErrorCode(error: unknown) {
  const { code, errno } = (error ?? {}) as { code?: string; errno?: string };
  return errno ?? code;
}

export class SharedIndex {
  constructor(
    private readonly db: SQL,
    private readonly embeddings: EmbeddingBackend,
    private readonly modelKey: string,
  ) {}

  private async writable(db: SQL, { tenant, principal }: Identity, repository: string) {
    const [grant] = await db`
      SELECT 1 FROM miru_repository_grants AS grants
      JOIN miru_repositories AS repos USING (tenant_id, repository_id)
      WHERE tenant_id = ${tenant} AND repository_id = ${repository}
        AND principal_id = ${principal} AND can_write AND model_key = ${this.modelKey}
        AND (expires_at IS NULL OR expires_at > now())
    `;
    if (!grant) throw new SharedIndexError(404, "Writable repository not found.");
  }

  private async fileState(db: SQL, tenant: string, repository: string, path: string) {
    const [file] = await db<FileState[]>`
      SELECT revision, content_hash FROM miru_files
      WHERE tenant_id = ${tenant} AND repository_id = ${repository} AND file_path = ${path}
    `;
    return file;
  }

  private async readGitState(db: SQL, tenant: string, repository: string) {
    const [state] = await db<GitState[]>`
      SELECT completed, active FROM miru_git_sync
      WHERE tenant_id = ${tenant} AND repository_id = ${repository}
    `;
    return state;
  }

  async gitState(identity: Identity, repository: string): Promise<GitState> {
    return this.db.begin(async (tx) => {
      await this.writable(tx, identity, repository);
      return (await this.readGitState(tx, identity.tenant, repository)) ?? EMPTY_GIT_STATE;
    });
  }

  async gitSync(
    identity: Identity,
    { action, repository, base, target }: GitSync,
  ): Promise<GitState> {
    const { tenant } = identity;
    return retryTransaction(this.db, async (tx) => {
      await this.writable(tx, identity, repository);
      const state = await this.readGitState(tx, tenant, repository);
      const current = state ?? EMPTY_GIT_STATE;
      if (!current.active && current.completed === target) return current;
      if (current.completed !== base || (current.active && current.active !== target)) {
        throw new SharedIndexError(
          409,
          "The Git sync state changed. Read the current state and retry.",
        );
      }
      if (action === "finish" && current.active !== target) {
        throw new SharedIndexError(409, "This Git sync has not started.");
      }
      if (action === "begin" && current.active === target) return current;
      if (!state) {
        const [indexed] = await tx`
          SELECT 1 FROM miru_files WHERE tenant_id = ${tenant} AND repository_id = ${repository} LIMIT 1
        `;
        if (indexed) throw new SharedIndexError(409, "Git sync requires a fresh repository index.");
      }
      const next =
        action === "begin"
          ? { completed: base, active: target }
          : { completed: target, active: null };
      await tx`
        UPSERT INTO miru_git_sync (tenant_id, repository_id, completed, active)
        VALUES (${tenant}, ${repository}, ${next.completed}, ${next.active})
      `;
      return next;
    });
  }

  private async checkWriteMode(db: SQL, tenant: string, change: PreparedChange) {
    const state = await this.readGitState(db, tenant, change.repository);
    if (change.gitSync) {
      if (state?.active === change.revision) return;
      throw new SharedIndexError(409, "This commit is not the active Git sync.");
    }
    if (state) throw new SharedIndexError(409, "Use sync-git to update this repository.");
  }

  async revision(identity: Identity, repository: string, path: string) {
    return this.db.begin(async (tx) => {
      await this.writable(tx, identity, repository);
      return {
        revision: (await this.fileState(tx, identity.tenant, repository, path))?.revision ?? null,
      };
    });
  }

  async update(identity: Identity, change: PreparedChange): Promise<FileUpdate> {
    const { tenant } = identity;
    const { repository, path, fileHash, revision } = change;
    const current = await this.db.begin(async (tx) => {
      await this.writable(tx, identity, repository);
      await this.checkWriteMode(tx, tenant, change);
      return this.fileState(tx, tenant, repository, path);
    });
    const initialState = contentState(current, change, fileHash);
    if (initialState === "unchanged") return { state: "unchanged", embeddedChunks: 0 };

    const chunks = initialState === "replace" ? change.chunks : [];
    const contentByHash = new Map<string, string>();
    for (const chunk of chunks) {
      if (chunk.start_line > chunk.end_line || sharedContentHash(chunk.content) !== chunk.hash) {
        throw new SharedIndexError(400, "Invalid chunk range or content hash.");
      }
      contentByHash.set(chunk.hash, chunk.content);
    }
    const cachedHashes = new Set<string>();
    if (contentByHash.size) {
      const hashes = [...contentByHash.keys()].join(",");
      const cached = await this.db<{ content_hash: string }[]>`
        SELECT content_hash FROM miru_embeddings
        WHERE tenant_id = ${tenant} AND repository_id = ${repository}
          AND content_hash = ANY(string_to_array(${hashes}, ','))
      `;
      for (const row of cached) cachedHashes.add(row.content_hash);
    }
    const missing = [...contentByHash.entries()].filter(([key]) => !cachedHashes.has(key));
    const embeddings: { content_hash: string; vector: string }[] = [];
    if (missing.length) {
      const vectors = await this.embeddings.embedDocuments(missing.map(([, text]) => text));
      if (vectors.length !== missing.length) {
        throw new SharedIndexError(502, "Embedding provider returned the wrong number of vectors.");
      }
      for (const [index, [key]] of missing.entries()) {
        const vector = vectors[index];
        if (!vector) throw new SharedIndexError(502, "Embedding provider omitted a vector.");
        embeddings.push({ content_hash: key, vector: vectorLiteral(vector) });
      }
    }

    return retryTransaction(this.db, async (tx) => {
      await this.writable(tx, identity, repository);
      await this.checkWriteMode(tx, tenant, change);
      const state = contentState(
        await this.fileState(tx, tenant, repository, path),
        change,
        fileHash,
      );
      if (state === "unchanged") return { state: "unchanged", embeddedChunks: 0 };

      await tx`
        UPSERT INTO miru_files (tenant_id, repository_id, file_path, revision, content_hash)
        VALUES (${tenant}, ${repository}, ${path}, ${revision}, ${fileHash})
      `;
      if (state === "replace") {
        await tx`
          DELETE FROM miru_chunks
          WHERE tenant_id = ${tenant} AND repository_id = ${repository} AND file_path = ${path}
        `;
        // Bind as text first: Bun's JSONB codec otherwise encodes a JSON string scalar.
        if (embeddings.length) {
          await tx`
            INSERT INTO miru_embeddings (tenant_id, repository_id, content_hash, embedding)
            SELECT ${tenant}, ${repository}, entry->>'content_hash', (entry->>'vector')::VECTOR
            FROM jsonb_array_elements(${JSON.stringify(embeddings)}::STRING::JSONB) AS payload(entry)
            ON CONFLICT DO NOTHING
          `;
        }
        const rows = chunks.map((chunk, ordinal) => ({
          ordinal,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          language: chunk.language,
          content: chunk.content,
          terms: tokenize(enrichForBm25({ ...chunk, file_path: path })).join(" "),
          content_hash: chunk.hash,
        }));
        if (rows.length) {
          await tx`
            INSERT INTO miru_chunks
              (tenant_id, repository_id, file_path, ordinal, start_line, end_line, language, content, lexemes, embedding)
            SELECT ${tenant}, ${repository}, ${path}, (chunk->>'ordinal')::INT,
              (chunk->>'start_line')::INT, (chunk->>'end_line')::INT,
              chunk->>'language', chunk->>'content', to_tsvector('simple', chunk->>'terms'), saved.embedding
            FROM jsonb_array_elements(${JSON.stringify(rows)}::STRING::JSONB) AS payload(chunk)
            JOIN miru_embeddings AS saved
              ON saved.tenant_id = ${tenant} AND saved.repository_id = ${repository}
              AND saved.content_hash = chunk->>'content_hash'
          `;
        }
      }
      return { state: "updated", embeddedChunks: missing.length };
    });
  }

  private async readable(db: SQL, { tenant, principal }: Identity, repositories: string[]) {
    const requested = [...new Set(repositories)].join(",");
    return db<{ repository_id: string }[]>`
      SELECT repository_id FROM miru_repository_grants AS grants
      JOIN miru_repositories AS repos USING (tenant_id, repository_id)
      WHERE tenant_id = ${tenant} AND principal_id = ${principal}
        AND repository_id = ANY(string_to_array(${requested}, ',')) AND model_key = ${this.modelKey}
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY repository_id
    `;
  }

  async search(
    identity: Identity,
    { query, repositories }: SearchQuery,
  ): Promise<SharedCandidates> {
    const { tenant, principal } = identity;
    const model = this.embeddings.model;
    if ((await this.readable(this.db, identity, repositories)).length === 0) {
      return { model, candidates: [] };
    }
    const vector = vectorLiteral(await this.embeddings.embedQuery(query));
    const terms = [...new Set(tokenize(query))].slice(0, 32).join(" | ");
    const candidates = await this.db.begin(async (tx) => {
      const groups: Candidate[][] = [];
      for (const { repository_id: repo } of await this.readable(tx, identity, repositories)) {
        const allowed = tx`
          EXISTS (
            SELECT 1 FROM miru_repository_grants
            WHERE tenant_id = ${tenant} AND repository_id = ${repo} AND principal_id = ${principal}
              AND (expires_at IS NULL OR expires_at > now())
          )
        `;
        // Keep the vector lookup on the indexed tenant and repository prefix.
        const semantic = await tx<Candidate[]>`
          WITH nearest AS MATERIALIZED (
            SELECT repository_id, file_path, start_line, end_line, language, content, embedding
            FROM miru_chunks@{FORCE_INDEX=miru_vector_idx}
            WHERE tenant_id = ${tenant} AND repository_id = ${repo}
            ORDER BY embedding <=> ${vector}::VECTOR LIMIT ${CANDIDATES_PER_REPOSITORY}
          )
          SELECT repository_id AS repository, file_path, start_line, end_line, language, content,
            1 - (embedding <=> ${vector}::VECTOR) AS similarity
          FROM nearest WHERE ${allowed}
          ORDER BY similarity DESC
        `;
        if (!terms) {
          groups.push(semantic);
          continue;
        }
        const lexical = await tx<Candidate[]>`
          SELECT repository_id AS repository, file_path, start_line, end_line, language, content,
            1 - (embedding <=> ${vector}::VECTOR) AS similarity
          FROM miru_chunks
          WHERE tenant_id = ${tenant} AND repository_id = ${repo} AND ${allowed}
            AND lexemes @@ to_tsquery('simple', ${terms})
          ORDER BY ts_rank(lexemes, to_tsquery('simple', ${terms})) DESC, file_path, ordinal
          LIMIT ${CANDIDATES_PER_REPOSITORY}
        `;
        groups.push(semantic, lexical);
      }
      // Leave headroom for the Lambda proxy response envelope and escaped JSON.
      const rows: Candidate[] = [];
      const seen = new Set<string>();
      let bytes = 0;
      for (let i = 0; i < CANDIDATES_PER_REPOSITORY; i++) {
        for (const group of groups) {
          const row = group[i];
          if (!row) continue;
          const key = JSON.stringify([row.repository, row.file_path, row.start_line, row.end_line]);
          if (seen.has(key)) continue;
          const result = {
            ...row,
            start_line: Number(row.start_line),
            end_line: Number(row.end_line),
            similarity: Number(row.similarity),
          };
          bytes += Buffer.byteLength(JSON.stringify(JSON.stringify(result)));
          if (bytes > 2_000_000) return rows;
          seen.add(key);
          rows.push(result);
        }
      }
      return rows;
    });
    return { model, candidates };
  }
}
