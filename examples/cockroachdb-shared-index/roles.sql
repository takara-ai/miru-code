-- Create the login credentials separately and store them outside source control.
CREATE ROLE IF NOT EXISTS miru_router;
CREATE ROLE IF NOT EXISTS miru_acl_sync;

GRANT SELECT ON TABLE miru_repositories, miru_repository_grants TO miru_router;
GRANT SELECT, INSERT, UPDATE ON TABLE miru_files TO miru_router;
GRANT SELECT, INSERT ON TABLE miru_embeddings TO miru_router;
GRANT SELECT, INSERT, DELETE ON TABLE miru_chunks TO miru_router;

GRANT SELECT, UPDATE ON TABLE miru_repositories TO miru_acl_sync;
GRANT SELECT, INSERT, DELETE ON TABLE miru_repository_grants TO miru_acl_sync;
