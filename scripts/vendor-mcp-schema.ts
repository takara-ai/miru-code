#!/usr/bin/env bun
import { MCP_SCHEMA_PATH, MCP_SCHEMA_URL, loadOfficialMcpSchema } from "../tests/helpers/mcp-schema.ts";

await loadOfficialMcpSchema();
const size = (await Bun.file(MCP_SCHEMA_PATH).arrayBuffer()).byteLength;
console.log(`Wrote ${MCP_SCHEMA_PATH} (${size} bytes) from ${MCP_SCHEMA_URL}`);
