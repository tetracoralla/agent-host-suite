#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { utf8Bytes } from "./canonical.js";
import { LIMITS, PRODUCT_VERSION } from "./constants.js";
import { executeAnalyze, executeDiff } from "./core.js";
import { ContextSurfaceError, errorResult } from "./errors.js";

const LATEST_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_LEGACY_PROTOCOL_VERSIONS = new Set([
  LATEST_LEGACY_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);

const INTEGER_LIMIT_SCHEMA = {
  type: "integer",
  minimum: LIMITS.minResultBytes,
  maximum: LIMITS.hardMaxResultBytes,
  description: "Maximum UTF-8 bytes allowed for the complete tool result."
};
const JSON_RPC_REQUEST_KEYS = new Set(["jsonrpc", "id", "method", "params"]);

// MCP outputSchema describes structuredContent, not the companion text summary.
// Keep it closed so a caller can rely on the result without receiving an
// implementation trace or unbounded arbitrary data in its catalog contract.
const SHA256_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$"
};
const NON_NEGATIVE_INTEGER_SCHEMA = {
  type: "integer",
  minimum: 0
};
const POSITIVE_INTEGER_SCHEMA = {
  type: "integer",
  minimum: 1
};
const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256 },
    revision: { type: "string", minLength: 1, maxLength: 256 }
  }
};
const SCHEMA_METRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sha256", "canonicalUtf8Bytes"],
  properties: {
    sha256: SHA256_SCHEMA,
    canonicalUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA
  }
};
const TOKEN_MEASUREMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["metric", "value", "source", "provider", "model", "serialization"],
  properties: {
    metric: { const: "input_tokens" },
    value: NON_NEGATIVE_INTEGER_SCHEMA,
    source: { enum: ["host-observed", "external-counter"] },
    provider: { type: "string", minLength: 1, maxLength: 256 },
    model: { type: "string", minLength: 1, maxLength: 256 },
    serialization: { type: "string", minLength: 1, maxLength: 256 },
    tokenizerVersion: { type: "string", minLength: 1, maxLength: 256 }
  }
};
const ERROR_DETAILS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    fieldCount: NON_NEGATIVE_INTEGER_SCHEMA,
    actual: NON_NEGATIVE_INTEGER_SCHEMA,
    limit: POSITIVE_INTEGER_SCHEMA,
    fields: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1
    },
    name: { type: "string", minLength: 1, maxLength: 256 }
  }
};
const ERROR_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "error"],
  properties: {
    status: { const: "error" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: {
          enum: [
            "INTERNAL_ERROR",
            "INVALID_ARGUMENT",
            "INVALID_INPUT",
            "INVALID_JSON",
            "INVALID_OUTPUT_LIMIT",
            "INVALID_SNAPSHOT",
            "LIMIT_EXCEEDED",
            "RESULT_BUDGET_EXCEEDED",
            "UNKNOWN_FIELD",
            "UNKNOWN_TOOL",
            "UNSUPPORTED_FORMAT"
          ]
        },
        message: { type: "string", minLength: 1 },
        details: ERROR_DETAILS_SCHEMA
      }
    }
  }
};
const ANALYZE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "status",
    "source",
    "snapshot",
    "catalog",
    "counts",
    "tools",
    "exactDuplicateSchemas",
    "hardNameCollisions",
    "budgetChecks",
    "tokenMeasurements",
    "measurementPolicy"
  ],
  properties: {
    format: { const: "context-surface.analysis.v0.1" },
    status: { const: "ok" },
    source: SOURCE_SCHEMA,
    snapshot: SCHEMA_METRIC_SCHEMA,
    catalog: {
      type: "object",
      additionalProperties: false,
      required: ["sha256", "canonicalUtf8Bytes", "largestToolUtf8Bytes"],
      properties: {
        sha256: SHA256_SCHEMA,
        canonicalUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
        largestToolUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA
      }
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["tools", "schemas", "describedTools", "tokenMeasurements"],
      properties: {
        tools: NON_NEGATIVE_INTEGER_SCHEMA,
        schemas: NON_NEGATIVE_INTEGER_SCHEMA,
        describedTools: NON_NEGATIVE_INTEGER_SCHEMA,
        tokenMeasurements: NON_NEGATIVE_INTEGER_SCHEMA
      }
    },
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "name", "canonicalUtf8Bytes", "descriptionUtf8Bytes", "inputSchema"],
        properties: {
          index: NON_NEGATIVE_INTEGER_SCHEMA,
          name: { type: "string", minLength: 1, maxLength: 256 },
          canonicalUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
          descriptionUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
          inputSchema: SCHEMA_METRIC_SCHEMA,
          outputSchema: SCHEMA_METRIC_SCHEMA
        }
      }
    },
    exactDuplicateSchemas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sha256", "canonicalUtf8Bytes", "occurrences"],
        properties: {
          sha256: SHA256_SCHEMA,
          canonicalUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
          occurrences: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["toolIndex", "toolName", "role"],
              properties: {
                toolIndex: NON_NEGATIVE_INTEGER_SCHEMA,
                toolName: { type: "string", minLength: 1, maxLength: 256 },
                role: { enum: ["input", "output"] }
              }
            }
          }
        }
      }
    },
    hardNameCollisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "toolIndices"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 256 },
          toolIndices: {
            type: "array",
            minItems: 2,
            items: NON_NEGATIVE_INTEGER_SCHEMA
          }
        }
      }
    },
    budgetChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "actual", "limit", "status"],
        properties: {
          metric: {
            enum: [
              "catalog.canonicalUtf8Bytes",
              "catalog.largestToolUtf8Bytes",
              "counts.tools"
            ]
          },
          actual: NON_NEGATIVE_INTEGER_SCHEMA,
          limit: POSITIVE_INTEGER_SCHEMA,
          status: { enum: ["within", "exceeded"] }
        }
      }
    },
    tokenMeasurements: {
      type: "array",
      items: TOKEN_MEASUREMENT_SCHEMA
    },
    measurementPolicy: { const: "reported-only; no byte-to-token inference" }
  }
};
const DIFF_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "status", "before", "after", "deltas", "tools", "tokenMeasurements", "measurementPolicy"],
  properties: {
    format: { const: "context-surface.diff.v0.1" },
    status: { const: "ok" },
    before: {
      type: "object",
      additionalProperties: false,
      required: ["source", "snapshotSha256", "catalogUtf8Bytes", "toolCount", "schemaCount", "hardNameCollisionCount"],
      properties: {
        source: SOURCE_SCHEMA,
        snapshotSha256: SHA256_SCHEMA,
        catalogUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
        toolCount: NON_NEGATIVE_INTEGER_SCHEMA,
        schemaCount: NON_NEGATIVE_INTEGER_SCHEMA,
        hardNameCollisionCount: NON_NEGATIVE_INTEGER_SCHEMA
      }
    },
    after: {
      type: "object",
      additionalProperties: false,
      required: ["source", "snapshotSha256", "catalogUtf8Bytes", "toolCount", "schemaCount", "hardNameCollisionCount"],
      properties: {
        source: SOURCE_SCHEMA,
        snapshotSha256: SHA256_SCHEMA,
        catalogUtf8Bytes: NON_NEGATIVE_INTEGER_SCHEMA,
        toolCount: NON_NEGATIVE_INTEGER_SCHEMA,
        schemaCount: NON_NEGATIVE_INTEGER_SCHEMA,
        hardNameCollisionCount: NON_NEGATIVE_INTEGER_SCHEMA
      }
    },
    deltas: {
      type: "object",
      additionalProperties: false,
      required: ["catalogUtf8Bytes", "toolCount", "schemaCount"],
      properties: {
        catalogUtf8Bytes: { type: "integer" },
        toolCount: { type: "integer" },
        schemaCount: { type: "integer" }
      }
    },
    tools: {
      type: "object",
      additionalProperties: false,
      required: ["added", "removed", "changed", "unchanged", "ambiguousDueToNameCollision", "reordered"],
      properties: {
        added: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
        removed: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
        changed: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "beforeSha256", "afterSha256", "canonicalUtf8BytesDelta", "descriptionChanged", "inputSchemaChanged", "outputSchemaChanged"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 256 },
              beforeSha256: SHA256_SCHEMA,
              afterSha256: SHA256_SCHEMA,
              canonicalUtf8BytesDelta: { type: "integer" },
              descriptionChanged: { type: "boolean" },
              inputSchemaChanged: { type: "boolean" },
              outputSchemaChanged: { type: "boolean" }
            }
          }
        },
        unchanged: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
        ambiguousDueToNameCollision: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "beforeCount", "afterCount"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 256 },
              beforeCount: NON_NEGATIVE_INTEGER_SCHEMA,
              afterCount: NON_NEGATIVE_INTEGER_SCHEMA
            }
          }
        },
        reordered: { type: ["boolean", "null"] }
      }
    },
    tokenMeasurements: {
      type: "object",
      additionalProperties: false,
      required: ["matched", "added", "removed"],
      properties: {
        matched: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["metric", "source", "provider", "model", "serialization", "before", "after", "delta"],
            properties: {
              metric: { const: "input_tokens" },
              source: { enum: ["host-observed", "external-counter"] },
              provider: { type: "string", minLength: 1, maxLength: 256 },
              model: { type: "string", minLength: 1, maxLength: 256 },
              serialization: { type: "string", minLength: 1, maxLength: 256 },
              tokenizerVersion: { type: "string", minLength: 1, maxLength: 256 },
              before: NON_NEGATIVE_INTEGER_SCHEMA,
              after: NON_NEGATIVE_INTEGER_SCHEMA,
              delta: { type: "integer" }
            }
          }
        },
        added: NON_NEGATIVE_INTEGER_SCHEMA,
        removed: NON_NEGATIVE_INTEGER_SCHEMA
      }
    },
    measurementPolicy: { const: "matched labels only; no byte-to-token inference" }
  }
};

export const TOOL_DEFINITIONS = [
  {
    name: "context.analyze",
    description: "Analyze one explicit Agent tool catalog snapshot for exact bytes, schemas, collisions, duplicates, declared budgets, and labeled token measurements.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_json"],
      properties: {
        snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "A context-surface.snapshot.v0.1 JSON document."
        },
        max_output_bytes: INTEGER_LIMIT_SCHEMA
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [ANALYZE_RESULT_SCHEMA, ERROR_RESULT_SCHEMA]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "context.diff",
    description: "Compare two explicit Agent tool catalog snapshots and return exact catalog, tool, schema, collision, and matched token-measurement deltas.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["before_snapshot_json", "after_snapshot_json"],
      properties: {
        before_snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "The earlier context-surface.snapshot.v0.1 JSON document."
        },
        after_snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "The later context-surface.snapshot.v0.1 JSON document."
        },
        max_output_bytes: INTEGER_LIMIT_SCHEMA
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [DIFF_RESULT_SCHEMA, ERROR_RESULT_SCHEMA]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function assertCallArguments(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Tool arguments must be an object.");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ContextSurfaceError("UNKNOWN_FIELD", "Unsupported tool fields.", { fieldCount: unknown.length });
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Tool arguments are missing required fields.", { fields: missing });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isValidRequestId(value) {
  if (typeof value === "string") return utf8Bytes(value) <= LIMITS.maxJsonRpcIdBytes;
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidRequestEnvelope(message) {
  if (!isRecord(message) || message.jsonrpc !== "2.0") return false;
  if (Object.keys(message).some((key) => !JSON_RPC_REQUEST_KEYS.has(key))) return false;
  if (
    typeof message.method !== "string" ||
    message.method.length === 0 ||
    utf8Bytes(message.method) > LIMITS.maxJsonRpcMethodBytes
  ) return false;
  if ("id" in message && !isValidRequestId(message.id)) return false;
  if ("params" in message && !isRecord(message.params)) return false;
  return true;
}

function summarize(name, result) {
  if (name === "context.analyze") {
    return `Analyzed ${result.counts.tools} tools and ${result.counts.schemas} schemas; found ${result.hardNameCollisions.length} hard name collisions.`;
  }
  return `Compared ${result.before.toolCount} to ${result.after.toolCount} tools; ${result.tools.changed.length} uniquely named tools changed.`;
}

function toolSuccess(name, execution) {
  const payload = {
    content: [{ type: "text", text: summarize(name, execution.result) }],
    structuredContent: execution.result,
    isError: false
  };
  const actual = utf8Bytes(JSON.stringify(payload));
  if (actual > execution.limit) {
    throw new ContextSurfaceError("RESULT_BUDGET_EXCEEDED", "Complete MCP tool result exceeds the output byte limit.", {
      actual,
      limit: execution.limit
    });
  }
  return payload;
}

function failurePayload(error, { compactText = false, omitDetails = false } = {}) {
  const structuredContent = errorResult(error);
  if (omitDetails) delete structuredContent.error.details;
  return {
    content: [{
      type: "text",
      text: compactText
        ? structuredContent.error.code
        : `${structuredContent.error.code}: ${structuredContent.error.message}`
    }],
    structuredContent,
    isError: true
  };
}

function requestedFailureLimit(args) {
  const value = args?.max_output_bytes;
  return Number.isSafeInteger(value) && value >= LIMITS.minResultBytes && value <= LIMITS.hardMaxResultBytes
    ? value
    : LIMITS.defaultResultBytes;
}

function toolFailure(error, limit) {
  const payload = failurePayload(error);
  if (utf8Bytes(JSON.stringify(payload)) <= limit) return payload;
  const compact = failurePayload(error, { compactText: true });
  if (utf8Bytes(JSON.stringify(compact)) <= limit) return compact;
  const withoutDetails = failurePayload(error, { compactText: true, omitDetails: true });
  if (utf8Bytes(JSON.stringify(withoutDetails)) <= limit) return withoutDetails;
  const bounded = failurePayload(new ContextSurfaceError(
    "RESULT_BUDGET_EXCEEDED",
    "Complete MCP error exceeds the output byte limit.",
    { limit }
  ));
  if (utf8Bytes(JSON.stringify(bounded)) <= limit) return bounded;
  return {
    content: [{ type: "text", text: "RESULT_BUDGET_EXCEEDED" }],
    structuredContent: {
      status: "error",
      error: { code: "RESULT_BUDGET_EXCEEDED", message: "Output limit is too small." }
    },
    isError: true
  };
}

export function callTool(name, args) {
  let failureLimit = requestedFailureLimit(args);
  try {
    if (name === "context.analyze") {
      assertCallArguments(args, ["snapshot_json", "max_output_bytes"], ["snapshot_json"]);
      const execution = executeAnalyze(args.snapshot_json, args.max_output_bytes);
      failureLimit = execution.limit;
      return toolSuccess(name, execution);
    }
    if (name === "context.diff") {
      assertCallArguments(
        args,
        ["before_snapshot_json", "after_snapshot_json", "max_output_bytes"],
        ["before_snapshot_json", "after_snapshot_json"]
      );
      const execution = executeDiff(args.before_snapshot_json, args.after_snapshot_json, args.max_output_bytes);
      failureLimit = execution.limit;
      return toolSuccess(name, execution);
    }
    // The advertised error details schema declares `name` as a bounded string;
    // keep hostile non-string names out of the structured result.
    throw new ContextSurfaceError(
      "UNKNOWN_TOOL",
      "The requested tool is not available.",
      typeof name === "string" && name.length > 0 && utf8Bytes(name) <= LIMITS.maxJsonRpcMethodBytes
        ? { name }
        : undefined
    );
  } catch (error) {
    const errorLimit = Number.isSafeInteger(error?.details?.limit)
      ? Math.min(failureLimit, error.details.limit)
      : failureLimit;
    return toolFailure(error, Math.max(LIMITS.minResultBytes, errorLimit));
  }
}

export function handleMessage(message) {
  if (!isValidRequestEnvelope(message)) return jsonRpcError(null, -32600, "Invalid Request");
  if (!("id" in message)) return null;
  if (message.method.startsWith("notifications/")) {
    return jsonRpcError(message.id, -32600, "Invalid Request");
  }
  if (message.method === "initialize") {
    const requestedVersion = message.params?.protocolVersion;
    if (typeof requestedVersion !== "string") {
      return jsonRpcError(message.id, -32602, "Invalid params");
    }
    const protocolVersion = SUPPORTED_LEGACY_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : LATEST_LEGACY_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "context-surface-analyzer", version: PRODUCT_VERSION }
      }
    };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    return { jsonrpc: "2.0", id: message.id, result: callTool(name, args) };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return jsonRpcError(message.id, -32601, "Method not found");
}

export function serializeMessage(response) {
  try {
    const json = JSON.stringify(response);
    if (utf8Bytes(json) <= LIMITS.maxMcpResponseBytes) return json;
  } catch {
    // Fall through to one fixed, bounded JSON-RPC error.
  }
  return JSON.stringify(jsonRpcError(null, -32603, "Response exceeds the MCP byte limit"));
}

function writeResponse(output, response) {
  if (!response) return true;
  return output.write(`${serializeMessage(response)}\n`);
}

function processLine(line, output) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return writeResponse(output, jsonRpcError(null, -32700, "Parse error"));
  }
  try {
    return writeResponse(output, handleMessage(message));
  } catch {
    return writeResponse(output, jsonRpcError(null, -32603, "Internal error"));
  }
}

export function startMcpServer(input = process.stdin, output = process.stdout) {
  input.setEncoding("utf8");
  let buffer = "";
  let bufferBytes = 0;
  let discardingOversizedLine = false;
  input.on("data", (chunk) => {
    let outputReady = true;
    const segments = chunk.split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const endsLine = index < segments.length - 1;
      if (discardingOversizedLine) {
        if (endsLine) discardingOversizedLine = false;
        continue;
      }

      const segmentBytes = utf8Bytes(segment);
      if (bufferBytes + segmentBytes > LIMITS.maxMcpRequestBytes) {
        buffer = "";
        bufferBytes = 0;
        discardingOversizedLine = !endsLine;
        outputReady = writeResponse(output, jsonRpcError(null, -32700, "Message too large")) && outputReady;
        continue;
      }

      buffer += segment;
      bufferBytes += segmentBytes;
      if (endsLine) {
        outputReady = processLine(buffer, output) && outputReady;
        buffer = "";
        bufferBytes = 0;
      }
    }
    if (!outputReady) {
      input.pause();
      output.once("drain", () => input.resume());
    }
  });
  input.on("end", () => {
    if (!discardingOversizedLine && buffer.length > 0) processLine(buffer, output);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMcpServer();
