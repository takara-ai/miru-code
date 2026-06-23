import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { loadOfficialMcpSchema, type McpSchemaDocument } from "./mcp-schema.ts";

const schemaDoc = (await loadOfficialMcpSchema()) as McpSchemaDocument;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<string, ValidateFunction>();

function validatorFor(def: string): ValidateFunction {
  const cached = validators.get(def);
  if (cached) {
    return cached;
  }

  const validate = ajv.compile({
    $schema: schemaDoc.$schema,
    $defs: schemaDoc.$defs,
    $ref: `#/$defs/${def}`,
  });
  validators.set(def, validate);
  return validate;
}

export function assertMatchesOfficialMcpSchema(def: string, value: unknown): void {
  const validate = validatorFor(def);
  if (validate(value)) {
    return;
  }

  const details = formatAjvErrors(validate.errors ?? []);
  throw new Error(`Value does not match official MCP schema ${def}:\n${details}`);
}

export function assertJsonRpcResultMatches(
  response: unknown,
  resultDef: string,
): asserts response is { jsonrpc: "2.0"; id: string | number; result: unknown } {
  assertMatchesOfficialMcpSchema("JSONRPCResultResponse", response);
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error("Expected JSON-RPC result response");
  }
  assertMatchesOfficialMcpSchema(resultDef, (response as { result: unknown }).result);
}

export function assertJsonRpcError(response: unknown): void {
  assertMatchesOfficialMcpSchema("JSONRPCErrorResponse", response);
}

function formatAjvErrors(errors: ErrorObject[]): string {
  return errors
    .map((error) => {
      const path = error.instancePath || "/";
      return `  ${path}: ${error.message ?? "invalid"} (${JSON.stringify(error.params)})`;
    })
    .join("\n");
}
