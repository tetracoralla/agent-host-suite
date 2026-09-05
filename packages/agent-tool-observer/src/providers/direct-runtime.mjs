import fs from "node:fs";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { readJsonlIncremental } from "../core/jsonl-reader.mjs";
import {
  getDirectRuntimeCursor,
  putDirectRuntimeCursor,
  putSemanticExecutionEvent
} from "../db.mjs";
import { ObserverError, stableErrorCode } from "../errors.mjs";

const EVENT_KEYS = new Set([
  "schemaVersion", "eventId", "workOrderHash", "callHash", "occurredAtMs",
  "completedAtMs", "target", "provider", "status", "errorCode", "timingMs",
  "payloadBytes", "sessionState", "bindingDigest", "contractDigest", "execution"
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} has an unknown field`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is missing a required field`);
  }
}

function boundedString(value, maximum, label, allowNull = false) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function identifier(value, label) {
  const result = boundedString(value, 200, label);
  if (!ID.test(result)) throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is invalid`);
  return result;
}

function digest(value, label, allowNull = false) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function nonNegativeNumber(value, label, allowNull = false) {
  if (allowNull && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function normalizeTarget(target) {
  if (target?.kind === "capability") {
    exactKeys(target, new Set(["kind", "capabilityId", "capabilityVersion", "operationId"]), "target");
    return {
      targetKind: "capability",
      semanticId: identifier(target.capabilityId, "capabilityId"),
      semanticVersion: boundedString(target.capabilityVersion, 100, "capabilityVersion"),
      operationId: identifier(target.operationId, "operationId"),
      toolName: null
    };
  }
  if (target?.kind === "procedure") {
    exactKeys(target, new Set(["kind", "procedureId", "procedureVersion"]), "target");
    return {
      targetKind: "procedure",
      semanticId: identifier(target.procedureId, "procedureId"),
      semanticVersion: boundedString(target.procedureVersion, 100, "procedureVersion"),
      operationId: null,
      toolName: null
    };
  }
  if (target?.kind === "mcp-tool") {
    exactKeys(target, new Set(["kind", "toolName"]), "target");
    return {
      targetKind: "mcp-tool",
      semanticId: null,
      semanticVersion: null,
      operationId: null,
      toolName: identifier(target.toolName, "toolName")
    };
  }
  if (target?.kind === "mcp-operation") {
    exactKeys(target, new Set(["kind", "toolName", "operationId"]), "target");
    return {
      targetKind: "mcp-operation",
      semanticId: null,
      semanticVersion: null,
      operationId: identifier(target.operationId, "operationId"),
      toolName: identifier(target.toolName, "toolName")
    };
  }
  throw new ObserverError("DIRECT_OBSERVATION_INVALID", "target kind is invalid");
}

function normalizeObservation(value, sourceId, recordedAtMs) {
  exactKeys(value, EVENT_KEYS, "observation");
  if (value.schemaVersion !== "openadam.direct-execution-observation.v0.1") {
    throw new ObserverError("DIRECT_OBSERVATION_UNSUPPORTED", "Direct Runtime observation version is unsupported");
  }
  const eventDigest = digest(value.eventId, "eventId");
  const occurredAtMs = nonNegativeInteger(value.occurredAtMs, "occurredAtMs");
  const completedAtMs = nonNegativeInteger(value.completedAtMs, "completedAtMs");
  if (completedAtMs < occurredAtMs) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", "completedAtMs precedes occurredAtMs");
  }
  exactKeys(value.provider, new Set(["id", "version", "transport", "lifecycle"]), "provider");
  const transports = new Set(["capability-jsonl-v0.1", "procedure-jsonl-v0.2", "mcp-stdio"]);
  const lifecycles = new Set(["persistent", "per-call"]);
  const statuses = new Set(["ok", "provider_error", "host_error"]);
  if (!transports.has(value.provider.transport) || !lifecycles.has(value.provider.lifecycle) || !statuses.has(value.status)) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", "provider or terminal status is invalid");
  }
  exactKeys(value.timingMs, new Set(["total", "queue", "providerRoundTrip"]), "timingMs");
  exactKeys(value.payloadBytes, new Set(["request", "response"]), "payloadBytes");
  exactKeys(value.execution, new Set(["modelCalls", "tokenUsage", "monetaryCost", "externalCostStatus"]), "execution");
  if (value.execution.modelCalls !== 0 || value.execution.tokenUsage !== null
      || value.execution.monetaryCost !== null || value.execution.externalCostStatus !== "not_observed") {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", "execution cost boundary is invalid");
  }
  if (!["cold", "warm", null].includes(value.sessionState)) {
    throw new ObserverError("DIRECT_OBSERVATION_INVALID", "sessionState is invalid");
  }
  return {
    eventId: eventIdentifier("direct-runtime", sourceId, eventDigest),
    sourceId,
    workOrderHash: digest(value.workOrderHash, "workOrderHash"),
    callHash: digest(value.callHash, "callHash"),
    occurredAtMs,
    completedAtMs,
    ...normalizeTarget(value.target),
    providerId: identifier(value.provider.id, "providerId"),
    providerVersion: boundedString(value.provider.version, 100, "providerVersion", true),
    transport: value.provider.transport,
    lifecycle: value.provider.lifecycle,
    status: value.status,
    errorCode: boundedString(value.errorCode, 160, "errorCode", true),
    durationMs: nonNegativeNumber(value.timingMs.total, "timingMs.total"),
    queueMs: nonNegativeNumber(value.timingMs.queue, "timingMs.queue", true),
    providerRoundTripMs: nonNegativeNumber(value.timingMs.providerRoundTrip, "timingMs.providerRoundTrip", true),
    requestBytes: nonNegativeInteger(value.payloadBytes.request, "payloadBytes.request"),
    responseBytes: value.payloadBytes.response === null
      ? null
      : nonNegativeInteger(value.payloadBytes.response, "payloadBytes.response"),
    sessionState: value.sessionState,
    bindingDigest: digest(value.bindingDigest, "bindingDigest", true),
    contractDigest: digest(value.contractDigest, "contractDigest", true),
    sourceFormat: value.schemaVersion,
    recordedAtMs
  };
}

function emptyHealth(scannedAtMs) {
  return {
    source: "direct-runtime",
    status: "ok",
    errorCode: null,
    filesSeen: 0,
    filesRead: 0,
    bytesRead: 0,
    linesRead: 0,
    eventsWritten: 0,
    skippedLines: 0,
    backlogSources: 0,
    scannedAtMs
  };
}

export function scanDirectRuntime({ database, config, scannedAtMs, deadlineMs, budget }) {
  const health = emptyHealth(scannedAtMs);
  let present = 0;
  const selectedLogs = config.directRuntimeLogs.slice(0, config.limits.maxFilesPerProvider);
  if (selectedLogs.length < config.directRuntimeLogs.length) {
    health.status = "partial";
    health.errorCode = "SOURCE_FILE_LIMIT_REACHED";
    health.backlogSources += config.directRuntimeLogs.length - selectedLogs.length;
  }
  for (const filePath of selectedLogs) {
    if (Date.now() >= deadlineMs) {
      if (health.status !== "error") health.status = "partial";
      health.errorCode = "RUN_DEADLINE_REACHED";
      health.backlogSources += 1;
      break;
    }
    let info;
    try {
      info = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      health.status = "error";
      health.errorCode = stableErrorCode(error, "SOURCE_FILE_READ_FAILED");
      continue;
    }
    present += 1;
    health.filesSeen += 1;
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      health.status = "error";
      health.errorCode = "SOURCE_FILE_INVALID";
      continue;
    }
    if (budget.remainingBytes <= 0 || budget.remainingLines <= 0) {
      if (health.status !== "error") health.status = "partial";
      health.errorCode ??= "RUN_BUDGET_REACHED";
      health.backlogSources += 1;
      continue;
    }
    const sourceId = hashIdentifier("source:direct-runtime", filePath);
    const cursor = getDirectRuntimeCursor(database, sourceId);
    const identity = `${info.dev}:${info.ino}`;
    const identityMatches = cursor?.file_identity === identity && cursor.offset_bytes <= info.size;
    const startOffset = identityMatches ? cursor.offset_bytes : 0;
    const discardingLine = identityMatches && cursor.discarding_line === 1;
    if (startOffset === info.size && !discardingLine) continue;
    let writes = 0;
    const allocatedBytes = Math.min(config.limits.maxBytesPerSource, budget.remainingBytes);
    const allocatedLines = Math.min(config.limits.maxLinesPerRun, budget.remainingLines);
    try {
      database.exec("BEGIN IMMEDIATE");
      const result = readJsonlIncremental({
        filePath,
        startOffset,
        discardingLine,
        expectedIdentity: identityMatches ? identity : null,
        maximumBytes: allocatedBytes,
        maximumLineBytes: Math.min(config.limits.maxLineBytes, 1024 * 1024),
        maximumLines: allocatedLines,
        maximumDepth: config.limits.maxJsonDepth,
        deadlineMs,
        onRecord(record) {
          writes += putSemanticExecutionEvent(
            database,
            normalizeObservation(record, sourceId, scannedAtMs)
          );
        }
      });
      putDirectRuntimeCursor(database, {
        sourceId,
        fileIdentity: result.fileIdentity,
        offsetBytes: result.nextOffset,
        sizeBytes: result.sizeBytes,
        mtimeMs: result.mtimeMs,
        discardingLine: result.discardingLine,
        skippedLines: result.skippedLines,
        updatedAtMs: scannedAtMs
      });
      database.exec("COMMIT");
      health.filesRead += 1;
      health.bytesRead += result.bytesRead;
      health.linesRead += result.linesRead;
      health.eventsWritten += writes;
      health.skippedLines += result.skippedLines;
      budget.remainingBytes -= result.bytesRead;
      budget.remainingLines -= result.linesRead;
      if (result.hasBacklog) {
        health.status = "partial";
        health.backlogSources += 1;
      }
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      budget.remainingBytes = Math.max(0, budget.remainingBytes - allocatedBytes);
      budget.remainingLines = Math.max(0, budget.remainingLines - allocatedLines);
      health.status = health.filesRead > 0 ? "partial" : "error";
      health.errorCode = stableErrorCode(error, "DIRECT_OBSERVATION_READ_FAILED");
    }
  }
  if (present === 0 && health.errorCode !== "SOURCE_FILE_LIMIT_REACHED") {
    return { ...health, status: "missing", errorCode: "DIRECT_OBSERVATION_LOG_MISSING" };
  }
  if (health.skippedLines > 0 && health.status === "ok") health.status = "partial";
  return health;
}
