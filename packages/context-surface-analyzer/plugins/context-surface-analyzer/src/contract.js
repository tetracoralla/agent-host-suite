import { canonicalize, utf8Bytes } from "./canonical.js";
import { LIMITS, SNAPSHOT_FORMAT } from "./constants.js";
import { ContextSurfaceError } from "./errors.js";

const TOP_LEVEL_KEYS = new Set(["format", "source", "tools", "measurements", "budgets"]);
const SOURCE_KEYS = new Set(["id", "revision"]);
const TOOL_KEYS = new Set(["name", "description", "inputSchema", "outputSchema"]);
const MEASUREMENT_KEYS = new Set([
  "metric",
  "value",
  "source",
  "provider",
  "model",
  "serialization",
  "tokenizerVersion"
]);
const BUDGET_KEYS = new Set([
  "maxCatalogUtf8Bytes",
  "maxToolCount",
  "maxLargestToolUtf8Bytes",
  "maxResultUtf8Bytes"
]);

function fail(code, message, details) {
  throw new ContextSurfaceError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail("INVALID_SNAPSHOT", `${path} must be an object.`);
}

function assertClosed(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("UNKNOWN_FIELD", `${path} contains unsupported fields.`, { path, fieldCount: unknown.length });
  }
}

function assertString(value, path, { required = true, maxBytes = LIMITS.maxStringBytes } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_SNAPSHOT", `${path} must be a non-empty string.`);
  }
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) fail("LIMIT_EXCEEDED", `${path} exceeds its UTF-8 byte limit.`, { path, actual: bytes, limit: maxBytes });
}

function assertPositiveInteger(value, path, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    fail("INVALID_SNAPSHOT", `${path} must be a positive safe integer no greater than ${max}.`);
  }
}

function inspectJsonValue(value, path, state, depth = 0) {
  if (depth > LIMITS.maxSchemaDepth) {
    fail("LIMIT_EXCEEDED", `${path} exceeds the schema nesting limit.`, { path, limit: LIMITS.maxSchemaDepth });
  }
  state.nodes += 1;
  if (state.nodes > LIMITS.maxSchemaNodes) {
    fail("LIMIT_EXCEEDED", `${path} exceeds the schema node limit.`, { path, limit: LIMITS.maxSchemaNodes });
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectJsonValue(item, `${path}[${index}]`, state, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      inspectJsonValue(item, `${path}.${key}`, state, depth + 1);
    }
    return;
  }
  fail("INVALID_SNAPSHOT", `${path} must contain JSON-compatible values only.`);
}

function validateSchema(schema, path, requestState) {
  if (!(typeof schema === "boolean" || isRecord(schema))) {
    fail("INVALID_SNAPSHOT", `${path} must be a JSON Schema object or boolean.`);
  }
  inspectJsonValue(schema, path, requestState);
  const bytes = utf8Bytes(canonicalize(schema));
  if (bytes > LIMITS.maxSchemaBytes) {
    fail("LIMIT_EXCEEDED", `${path} exceeds the canonical schema byte limit.`, {
      path,
      actual: bytes,
      limit: LIMITS.maxSchemaBytes
    });
  }
}

function validateSource(source) {
  assertRecord(source, "source");
  assertClosed(source, SOURCE_KEYS, "source");
  assertString(source.id, "source.id", { maxBytes: 256 });
  assertString(source.revision, "source.revision", { required: false, maxBytes: 256 });
}

function validateTools(tools) {
  if (!Array.isArray(tools)) fail("INVALID_SNAPSHOT", "tools must be an array.");
  if (tools.length > LIMITS.maxTools) {
    fail("LIMIT_EXCEEDED", "tools exceeds the tool count limit.", { actual: tools.length, limit: LIMITS.maxTools });
  }
  const schemaState = { nodes: 0 };
  tools.forEach((tool, index) => {
    const path = `tools[${index}]`;
    assertRecord(tool, path);
    assertClosed(tool, TOOL_KEYS, path);
    assertString(tool.name, `${path}.name`, { maxBytes: 256 });
    assertString(tool.description, `${path}.description`, { required: false, maxBytes: 4096 });
    if (!("inputSchema" in tool)) fail("INVALID_SNAPSHOT", `${path}.inputSchema is required.`);
    validateSchema(tool.inputSchema, `${path}.inputSchema`, schemaState);
    if ("outputSchema" in tool) validateSchema(tool.outputSchema, `${path}.outputSchema`, schemaState);
  });
}

function measurementIdentity(measurement) {
  // JSON string literals keep the join unambiguous: a crafted label that
  // itself contains the unit separator encodes it as escaped text, so two
  // different label sets can never produce the same identity string.
  return [
    measurement.metric,
    measurement.source,
    measurement.provider,
    measurement.model,
    measurement.serialization,
    measurement.tokenizerVersion ?? ""
  ]
    .map((field) => JSON.stringify(field))
    .join("\u001f");
}

function validateMeasurements(measurements = []) {
  if (!Array.isArray(measurements)) fail("INVALID_SNAPSHOT", "measurements must be an array.");
  if (measurements.length > LIMITS.maxMeasurements) {
    fail("LIMIT_EXCEEDED", "measurements exceeds the count limit.", {
      actual: measurements.length,
      limit: LIMITS.maxMeasurements
    });
  }
  const identities = new Set();
  measurements.forEach((measurement, index) => {
    const path = `measurements[${index}]`;
    assertRecord(measurement, path);
    assertClosed(measurement, MEASUREMENT_KEYS, path);
    if (measurement.metric !== "input_tokens") {
      fail("INVALID_SNAPSHOT", `${path}.metric must be input_tokens.`);
    }
    if (!Number.isSafeInteger(measurement.value) || measurement.value < 0) {
      fail("INVALID_SNAPSHOT", `${path}.value must be a non-negative safe integer.`);
    }
    if (!new Set(["host-observed", "external-counter"]).has(measurement.source)) {
      fail("INVALID_SNAPSHOT", `${path}.source must be host-observed or external-counter.`);
    }
    for (const key of ["provider", "model", "serialization"]) {
      assertString(measurement[key], `${path}.${key}`, { maxBytes: 256 });
    }
    assertString(measurement.tokenizerVersion, `${path}.tokenizerVersion`, { required: false, maxBytes: 256 });
    const identity = measurementIdentity(measurement);
    if (identities.has(identity)) fail("INVALID_SNAPSHOT", `${path} duplicates a measurement identity.`);
    identities.add(identity);
  });
}

function validateBudgets(budgets = {}) {
  assertRecord(budgets, "budgets");
  assertClosed(budgets, BUDGET_KEYS, "budgets");
  for (const key of ["maxCatalogUtf8Bytes", "maxToolCount", "maxLargestToolUtf8Bytes"]) {
    if (key in budgets) assertPositiveInteger(budgets[key], `budgets.${key}`);
  }
  if ("maxResultUtf8Bytes" in budgets) {
    assertPositiveInteger(budgets.maxResultUtf8Bytes, "budgets.maxResultUtf8Bytes", LIMITS.hardMaxResultBytes);
    if (budgets.maxResultUtf8Bytes < LIMITS.minResultBytes) {
      fail("INVALID_SNAPSHOT", `budgets.maxResultUtf8Bytes must be at least ${LIMITS.minResultBytes}.`);
    }
  }
}

export function parseSnapshotJson(text) {
  if (typeof text !== "string") fail("INVALID_INPUT", "snapshot_json must be a string.");
  const rawBytes = utf8Bytes(text);
  if (rawBytes > LIMITS.maxSnapshotBytes) {
    fail("LIMIT_EXCEEDED", "Snapshot JSON exceeds the input byte limit.", {
      actual: rawBytes,
      limit: LIMITS.maxSnapshotBytes
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("INVALID_JSON", "Snapshot input is not valid JSON.");
  }
  return validateSnapshot(value);
}

export function validateSnapshot(snapshot) {
  assertRecord(snapshot, "snapshot");
  assertClosed(snapshot, TOP_LEVEL_KEYS, "snapshot");
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    fail("UNSUPPORTED_FORMAT", `format must be ${SNAPSHOT_FORMAT}.`);
  }
  validateSource(snapshot.source);
  validateTools(snapshot.tools);
  validateMeasurements(snapshot.measurements ?? []);
  validateBudgets(snapshot.budgets ?? {});
  return snapshot;
}

export function getMeasurementIdentity(measurement) {
  return measurementIdentity(measurement);
}
