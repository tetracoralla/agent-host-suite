import { statSourcePath } from "../core/source-stat.mjs";
import fs from "node:fs";
import path from "node:path";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { readJsonlIncremental } from "../core/jsonl-reader.mjs";
import {
  getTraceCursor,
  putTraceAdapterHealth,
  putTraceCursor,
  putTraceModelStep,
  putTraceToolEvent,
  putTraceToolOffer,
  putTraceTurnEvent
} from "../db.mjs";
import { ObserverError, stableErrorCode } from "../errors.mjs";
import { traceAdapterById } from "../trace-adapters.mjs";

const BRIDGE_SCHEMA_VERSION = "openadam.agent-shell-trace-bridge.v0.1";
const KNOWN_KEYS = new Set([
  "schemaVersion", "adapter", "provider", "eventId", "sessionId", "turnId",
  "requestId", "callId", "kind", "occurredAt", "completedAt", "model",
  "querySource", "finishReason", "status", "toolName", "attempt",
  "durationMs", "requestBytes", "responseBytes", "requestMessageCount",
  "offeredToolCount", "emittedToolCallCount", "inputTokens",
  "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens",
  "selfReportedRationalePresent", "stableErrorCode", "stableReason",
  "contentIncluded"
]);

const ADAPTER_KEYS = new Set(["id", "version", "sourceFormat", "providerVersion"]);
const BRIDGE_FILE_ADAPTERS = Object.freeze({
  "claude-hooks.jsonl": "openadam.claude-code-hooks",
  "deepseek-harness.jsonl": "openadam.deepseek-harness-session-events",
  "github-copilot-cli.jsonl": "openadam.github-copilot-cli-hooks"
});

function boundedString(value, maximumBytes, required = false) {
  if (value === null || value === undefined) {
    if (required) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record is missing required text");
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximumBytes) {
    throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record contains invalid text");
  }
  return value;
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record must be an object");
  if (Object.keys(record).some((key) => !KNOWN_KEYS.has(key))) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record contains unknown fields");
  if (record.schemaVersion !== BRIDGE_SCHEMA_VERSION || record.contentIncluded !== false) {
    throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record has an unsupported version or content policy");
  }
  if (!record.adapter || typeof record.adapter !== "object" || Array.isArray(record.adapter)) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge adapter identity is missing");
  if (Object.keys(record.adapter).some((key) => !ADAPTER_KEYS.has(key))) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge adapter identity contains unknown fields");
  const adapterId = boundedString(record.adapter.id, 100, true);
  const adapterVersion = boundedString(record.adapter.version, 64, true);
  const sourceFormat = boundedString(record.adapter.sourceFormat, 100, true);
  const providerVersion = boundedString(record.adapter.providerVersion, 100);
  const descriptor = traceAdapterById(adapterId);
  if (descriptor === null || descriptor.provider !== record.provider) {
    throw new ObserverError("TRACE_BRIDGE_ADAPTER_UNSUPPORTED", "Trace bridge adapter identity is unsupported");
  }
  if (adapterVersion !== descriptor.version || !descriptor.runtime.sourceFormats.includes(BRIDGE_SCHEMA_VERSION) || !descriptor.runtime.sourceFormats.includes(sourceFormat)) {
    throw new ObserverError("TRACE_BRIDGE_ADAPTER_VERSION_UNSUPPORTED", "Trace bridge adapter version is unsupported");
  }
  const eventId = boundedString(record.eventId, 300, true);
  const sessionId = boundedString(record.sessionId, 300);
  const turnValue = typeof record.turnId === "number" ? String(record.turnId) : record.turnId;
  const turnId = boundedString(turnValue, 300);
  const requestId = boundedString(record.requestId, 300);
  const callId = boundedString(record.callId, 300);
  const occurredAtMs = nonNegativeInteger(record.occurredAt);
  const completedAtMs = nonNegativeInteger(record.completedAt);
  if (occurredAtMs === undefined) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge record has invalid time");
  const allowedKinds = new Set(["model-step", "tool-offer", "tool-call", "tool-result", "turn-end"]);
  if (!allowedKinds.has(record.kind)) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge event kind is unsupported");
  const status = boundedString(record.status, 20);
  if (status !== null && !["observed", "completed", "error", "cancelled", "unknown"].includes(status)) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge status is invalid");
  for (const value of [
    nonNegativeInteger(record.attempt), nonNegativeNumber(record.durationMs),
    nonNegativeInteger(record.requestBytes), nonNegativeInteger(record.responseBytes),
    nonNegativeInteger(record.requestMessageCount), nonNegativeInteger(record.offeredToolCount),
    nonNegativeInteger(record.emittedToolCallCount), nonNegativeInteger(record.inputTokens),
    nonNegativeInteger(record.cachedInputTokens), nonNegativeInteger(record.outputTokens),
    nonNegativeInteger(record.reasoningTokens), nonNegativeInteger(record.totalTokens)
  ]) if (value === undefined) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge numeric field is invalid");
  if (record.selfReportedRationalePresent !== null && record.selfReportedRationalePresent !== undefined && typeof record.selfReportedRationalePresent !== "boolean") {
    throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Trace bridge rationale presence is invalid");
  }
  return {
    descriptor,
    adapterId,
    adapterVersion,
    providerVersion,
    sourceFormat,
    eventId,
    sessionId,
    turnId,
    requestId,
    callId,
    occurredAtMs,
    completedAtMs,
    status,
    model: boundedString(record.model, 200),
    querySource: boundedString(record.querySource, 100),
    finishReason: boundedString(record.finishReason, 100),
    toolName: boundedString(record.toolName, 256),
    stableErrorCode: boundedString(record.stableErrorCode, 100),
    stableReason: boundedString(record.stableReason, 100),
    attempt: nonNegativeInteger(record.attempt),
    durationMs: nonNegativeNumber(record.durationMs),
    requestBytes: nonNegativeInteger(record.requestBytes),
    responseBytes: nonNegativeInteger(record.responseBytes),
    requestMessageCount: nonNegativeInteger(record.requestMessageCount),
    offeredToolCount: nonNegativeInteger(record.offeredToolCount),
    emittedToolCallCount: nonNegativeInteger(record.emittedToolCallCount),
    inputTokens: nonNegativeInteger(record.inputTokens),
    cachedInputTokens: nonNegativeInteger(record.cachedInputTokens),
    outputTokens: nonNegativeInteger(record.outputTokens),
    reasoningTokens: nonNegativeInteger(record.reasoningTokens),
    totalTokens: nonNegativeInteger(record.totalTokens),
    rationalePresent: record.selfReportedRationalePresent ?? null,
    kind: record.kind
  };
}

function bridgeParser({ database, sourceId, recordedAtMs, expectedAdapterId = null }) {
  let writes = 0;
  let adapter = expectedAdapterId === null ? null : traceAdapterById(expectedAdapterId);
  let providerVersion = null;
  return {
    onRecord(record) {
      const value = validateRecord(record);
      if (adapter !== null && adapter.id !== value.adapterId) throw new ObserverError("TRACE_BRIDGE_MIXED_ADAPTERS", "One trace bridge file must contain one adapter identity");
      adapter = value.descriptor;
      if (providerVersion !== null && value.providerVersion !== null && providerVersion !== value.providerVersion) {
        throw new ObserverError("TRACE_BRIDGE_PROVIDER_VERSION_CHANGED", "One trace bridge file must contain one provider version");
      }
      providerVersion ??= value.providerVersion;
      const sessionHash = hashIdentifier(`${record.provider}-session`, value.sessionId);
      const turnHash = hashIdentifier(`${record.provider}-turn`, value.turnId);
      const requestHash = hashIdentifier(`${record.provider}-request`, value.requestId);
      const callHash = hashIdentifier(`${record.provider}-call`, value.callId);
      const common = {
        provider: record.provider,
        adapterId: value.adapterId,
        adapterVersion: value.adapterVersion,
        providerVersion: value.providerVersion,
        sourceId,
        sessionHash,
        turnHash,
        requestHash,
        sourceFormat: value.sourceFormat,
        recordedAtMs
      };
      if (value.kind === "model-step") {
        writes += putTraceModelStep(database, {
          ...common,
          eventId: eventIdentifier(record.provider, "bridge-model-step", value.sessionId, value.turnId, value.requestId ?? value.eventId),
          occurredAtMs: value.occurredAtMs,
          completedAtMs: value.completedAtMs,
          modelId: value.model,
          querySource: value.querySource,
          finishReason: value.finishReason,
          status: value.status ?? "unknown",
          attempt: value.attempt,
          durationMs: value.durationMs,
          requestBytes: value.requestBytes,
          responseBytes: value.responseBytes,
          requestMessageCount: value.requestMessageCount,
          offeredToolCount: value.offeredToolCount,
          emittedToolCallCount: value.emittedToolCallCount,
          inputTokens: value.inputTokens,
          cachedInputTokens: value.cachedInputTokens,
          outputTokens: value.outputTokens,
          reasoningTokens: value.reasoningTokens,
          totalTokens: value.totalTokens,
          rationalePresent: value.rationalePresent,
          stableErrorCode: value.stableErrorCode
        });
      } else if (value.kind === "tool-offer") {
        if (value.toolName === null || value.requestId === null) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Tool offer requires toolName and requestId");
        const parentEventId = eventIdentifier(record.provider, "bridge-model-step", value.sessionId, value.turnId, value.requestId);
        writes += putTraceToolOffer(database, { eventId: parentEventId, toolName: value.toolName });
      } else if (value.kind === "tool-call" || value.kind === "tool-result") {
        if (value.toolName === null || value.callId === null) throw new ObserverError("TRACE_BRIDGE_EVENT_INVALID", "Tool trace requires toolName and callId");
        writes += putTraceToolEvent(database, {
          ...common,
          eventId: eventIdentifier(record.provider, `bridge-${value.kind}`, value.sessionId, value.callId),
          callHash,
          kind: value.kind,
          occurredAtMs: value.occurredAtMs,
          completedAtMs: value.completedAtMs,
          toolName: value.toolName,
          status: value.status ?? "unknown",
          requestBytes: value.requestBytes,
          responseBytes: value.responseBytes,
          stableErrorCode: value.stableErrorCode
        });
      } else {
        writes += putTraceTurnEvent(database, {
          ...common,
          eventId: eventIdentifier(record.provider, "bridge-turn-end", value.sessionId, value.turnId ?? value.eventId),
          occurredAtMs: value.occurredAtMs,
          completedAtMs: value.completedAtMs,
          status: value.status === "observed" || value.status === null ? "unknown" : value.status,
          stableReason: value.stableReason,
          stableErrorCode: value.stableErrorCode
        });
      }
    },
    adapter() { return adapter; },
    providerVersion() { return providerVersion; },
    eventsWritten() { return writes; }
  };
}

function health(adapter, scannedAtMs) {
  return {
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    provider: adapter.provider,
    transport: adapter.transport,
    providerVersion: null,
    status: "ok",
    errorCode: null,
    filesSeen: 1,
    filesRead: 0,
    bytesRead: 0,
    linesRead: 0,
    eventsWritten: 0,
    skippedLines: 0,
    backlogSources: 0,
    scannedAtMs
  };
}

export function scanTraceBridges({ database, config, scannedAtMs, budget }) {
  const results = [];
  for (const filePath of config.traceBridgeLogs) {
    if (!fs.existsSync(filePath)) continue;
    let sourceStat;
    try {
      sourceStat = statSourcePath(filePath);
    } catch {
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
    if (budget.remainingBytes <= 0 || budget.remainingLines <= 0 || Date.now() >= budget.deadlineMs) break;
    const sourceId = hashIdentifier("source:trace-bridge", filePath);
    const cursor = getTraceCursor(database, sourceId);
    const identity = `${sourceStat.dev}:${sourceStat.ino}`;
    const identityMatches = cursor?.file_identity === identity;
    const sizeMatches = cursor && cursor.offset_bytes <= sourceStat.size;
    const startOffset = identityMatches && sizeMatches ? cursor.offset_bytes : 0;
    const discardingLine = identityMatches && sizeMatches && cursor.discarding_line === 1;
    if (startOffset === sourceStat.size && !discardingLine) continue;
    const expectedAdapterId = BRIDGE_FILE_ADAPTERS[path.basename(filePath)] ?? cursor?.adapter_id ?? null;
    const parser = bridgeParser({ database, sourceId, recordedAtMs: scannedAtMs, expectedAdapterId });
    const maximumBytes = Math.min(config.limits.maxBytesPerSource, budget.remainingBytes);
    const maximumLines = Math.min(config.limits.maxLinesPerRun, budget.remainingLines);
    try {
      database.exec("BEGIN IMMEDIATE");
      const read = readJsonlIncremental({
        filePath,
        startOffset,
        discardingLine,
        expectedIdentity: identityMatches ? identity : null,
        maximumBytes,
        maximumLineBytes: config.limits.maxLineBytes,
        maximumLines,
        maximumDepth: config.limits.maxJsonDepth,
        deadlineMs: budget.deadlineMs,
        onRecord: parser.onRecord
      });
      const adapter = parser.adapter();
      if (adapter === null && read.recordsRead > 0) throw new ObserverError("TRACE_BRIDGE_ADAPTER_UNSUPPORTED", "Trace bridge file has no supported adapter records");
      putTraceCursor(database, {
        sourceId,
        adapterId: adapter?.id ?? cursor?.adapter_id ?? "openadam.trace-bridge-empty",
        fileIdentity: read.fileIdentity,
        offsetBytes: read.nextOffset,
        sizeBytes: read.sizeBytes,
        mtimeMs: read.mtimeMs,
        discardingLine: read.discardingLine,
        skippedLines: read.skippedLines,
        updatedAtMs: scannedAtMs
      });
      database.exec("COMMIT");
      budget.remainingBytes -= read.bytesRead;
      budget.remainingLines -= read.linesRead;
      if (adapter !== null) {
        const result = health(adapter, scannedAtMs);
        result.providerVersion = parser.providerVersion();
        result.filesRead = 1;
        result.bytesRead = read.bytesRead;
        result.linesRead = read.linesRead;
        result.eventsWritten = parser.eventsWritten();
        result.skippedLines = read.skippedLines;
        result.backlogSources = read.hasBacklog ? 1 : 0;
        if (read.skippedLines > 0 || read.hasBacklog) result.status = "partial";
        putTraceAdapterHealth(database, result);
        results.push(result);
      }
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      budget.remainingBytes = Math.max(0, budget.remainingBytes - maximumBytes);
      budget.remainingLines = Math.max(0, budget.remainingLines - maximumLines);
      const adapter = parser.adapter();
      if (adapter !== null) {
        const result = health(adapter, scannedAtMs);
        result.status = "error";
        result.errorCode = stableErrorCode(error, "TRACE_BRIDGE_READ_FAILED");
        putTraceAdapterHealth(database, result);
        results.push(result);
      } else {
        results.push({
          adapterId: null,
          adapterVersion: null,
          provider: "trace-bridge",
          transport: null,
          providerVersion: null,
          status: "error",
          errorCode: stableErrorCode(error, "TRACE_BRIDGE_READ_FAILED"),
          filesSeen: 1,
          filesRead: 0,
          bytesRead: 0,
          linesRead: 0,
          eventsWritten: 0,
          skippedLines: 0,
          backlogSources: 0,
          scannedAtMs
        });
      }
    }
  }
  return results;
}

export { bridgeParser, validateRecord as validateTraceBridgeRecord };
