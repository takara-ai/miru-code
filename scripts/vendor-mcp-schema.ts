#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = "2025-11-25";
const OUT_PATH = join(
  import.meta.dir,
  "..",
  "tests",
  "fixtures",
  "mcp",
  `schema-${SCHEMA_VERSION}.json`,
);
const SOURCE_URL = `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/${SCHEMA_VERSION}/schema.json`;

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Failed to download MCP schema (${response.status}): ${SOURCE_URL}`);
}

const schema = await response.text();
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, schema);
console.log(`Wrote ${OUT_PATH} (${schema.length} bytes) from ${SOURCE_URL}`);
