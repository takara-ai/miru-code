-- Apply as the database owner. The application role must not own these tables.
SET CLUSTER SETTING feature.vector_index.enabled = true;

CREATE TABLE IF NOT EXISTS miru_repositories (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  model_key STRING NOT NULL,
  github_acl_started_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, repository_id)
);

CREATE TABLE IF NOT EXISTS miru_repository_grants (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  principal_id STRING NOT NULL,
  can_write BOOL NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  managed_by_github BOOL NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, principal_id, repository_id),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES miru_repositories
);

CREATE TABLE IF NOT EXISTS miru_files (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  file_path STRING NOT NULL,
  revision STRING NOT NULL,
  content_hash STRING,
  PRIMARY KEY (tenant_id, repository_id, file_path),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES miru_repositories
);

CREATE TABLE IF NOT EXISTS miru_git_sync (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  completed STRING,
  active STRING,
  PRIMARY KEY (tenant_id, repository_id),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES miru_repositories
);

CREATE TABLE IF NOT EXISTS miru_embeddings (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  content_hash STRING NOT NULL,
  embedding VECTOR(256) NOT NULL,
  PRIMARY KEY (tenant_id, repository_id, content_hash),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES miru_repositories
);

CREATE TABLE IF NOT EXISTS miru_chunks (
  tenant_id STRING NOT NULL,
  repository_id STRING NOT NULL,
  file_path STRING NOT NULL,
  ordinal INT NOT NULL,
  start_line INT NOT NULL CHECK (start_line >= 1),
  end_line INT NOT NULL CHECK (end_line >= start_line),
  language STRING,
  content STRING NOT NULL,
  lexemes TSVECTOR NOT NULL,
  embedding VECTOR(256) NOT NULL,
  PRIMARY KEY (tenant_id, repository_id, file_path, ordinal),
  FOREIGN KEY (tenant_id, repository_id, file_path) REFERENCES miru_files,
  VECTOR INDEX miru_vector_idx (tenant_id, repository_id, embedding vector_cosine_ops)
);

CREATE INVERTED INDEX IF NOT EXISTS miru_lexical_idx
  ON miru_chunks (tenant_id, repository_id, lexemes);
