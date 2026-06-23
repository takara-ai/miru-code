import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MCP_SCHEMA_VERSION = "2025-11-25";

export const MCP_SCHEMA_PATH = join(
  import.meta.dir,
  "..",
  "fixtures",
  "mcp",
  `schema-${MCP_SCHEMA_VERSION}.json`,
);

export const MCP_SCHEMA_URL = `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/${MCP_SCHEMA_VERSION}/schema.json`;

export type McpSchemaDocument = {
  $schema: string;
  $defs: Record<string, Record<string, unknown>>;
};

export async function loadOfficialMcpSchema(): Promise<McpSchemaDocument> {
  const cached = Bun.file(MCP_SCHEMA_PATH);
  if (await cached.exists()) {
    return (await cached.json()) as McpSchemaDocument;
  }

  const response = await fetch(MCP_SCHEMA_URL);
  if (!response.ok) {
    throw new Error(`Failed to download MCP schema (${response.status}): ${MCP_SCHEMA_URL}`);
  }

  const schema = await response.text();
  await mkdir(dirname(MCP_SCHEMA_PATH), { recursive: true });
  await Bun.write(MCP_SCHEMA_PATH, schema);
  return JSON.parse(schema) as McpSchemaDocument;
}
