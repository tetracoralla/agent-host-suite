import fs from "node:fs";
import path from "node:path";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { readJsonObjectsIncremental } from "../core/json-object-reader.mjs";
import { getTraceCursor, putTraceAdapterHealth, putTraceCursor, putTraceModelStep, putTraceToolEvent } from "../db.mjs";
import { ObserverError, stableErrorCode } from "../errors.mjs";
import { traceAdapterById } from "../trace-adapters.mjs";

export const GEMINI_OTEL_ADAPTER = Object.freeze({
  adapterId: "openadam.gemini-cli-otel",
  adapterVersion: "0.1.0",
  provider: "gemini-cli",
  transport: "opentelemetry",
  sourceFormat: "gemini-cli-otel"
});

const CONTENT_ATTRIBUTE_KEYS = new Set([
  "prompt", "function_args", "request_text", "response_text",
  "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions"
]);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function text(value, maximumBytes) {
  if (typeof value !== "string" || value.length === 0) return null;
  while (Buffer.byteLength(value) > maximumBytes) value = value.slice(0, -1);
  return value || null;
}

function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function providerVersion(record) {
  const attributes = record?.resource?.attributes;
  return text(attributes?.["service.version"] ?? attributes?.serviceVersion, 100);
}

function containsContentAttributes(attributes) {
  return Object.keys(attributes).some((key) => CONTENT_ATTRIBUTE_KEYS.has(key));
}

function geminiParser({ database, sourceId, recordedAtMs }) {
  const descriptor = traceAdapterById(GEMINI_OTEL_ADAPTER.adapterId);
  if (!descriptor) throw new ObserverError("TRACE_ADAPTER_CATALOG_MISSING", "Gemini CLI trace adapter descriptor is unavailable");
  let writes = 0;
  let recognized = 0;
  let contentFiltered = 0;
  let observedProviderVersion = null;
  const project = (record) => {
    const attributes = record?.attributes;
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return;
    const eventName = attributes["event.name"];
    if (!["gemini_cli.api_request", "gemini_cli.api_response", "gemini_cli.api_error", "gemini_cli.tool_call"].includes(eventName)) return;
    recognized += 1;
    if (containsContentAttributes(attributes)) {
      contentFiltered += 1;
      return;
    }
    const sessionId = attributes["session.id"] ?? attributes.session_id ?? "unknown";
    const promptId = attributes.prompt_id ?? null;
    const occurredAtMs = time(attributes["event.timestamp"]) ?? recordedAtMs;
    const sessionHash = hashIdentifier("gemini-cli-session", sessionId);
    const turnHash = hashIdentifier("gemini-cli-turn", promptId);
    const requestHash = hashIdentifier("gemini-cli-request", promptId);
    observedProviderVersion ??= providerVersion(record);
    const common = {
      provider: GEMINI_OTEL_ADAPTER.provider,
      adapterId: GEMINI_OTEL_ADAPTER.adapterId,
      adapterVersion: GEMINI_OTEL_ADAPTER.adapterVersion,
      providerVersion: observedProviderVersion,
      sourceId,
      sessionHash,
      turnHash,
      requestHash,
      sourceFormat: GEMINI_OTEL_ADAPTER.sourceFormat,
      recordedAtMs
    };
    if (eventName === "gemini_cli.api_request" || eventName === "gemini_cli.api_response" || eventName === "gemini_cli.api_error") {
      const isRequest = eventName === "gemini_cli.api_request";
      const isError = eventName === "gemini_cli.api_error";
      const finishReasons = Array.isArray(attributes.finish_reasons) ? attributes.finish_reasons : [];
      writes += putTraceModelStep(database, {
        ...common,
        eventId: eventIdentifier("gemini-cli", "otel-model-step", sessionId, promptId ?? attributes["event.timestamp"]),
        occurredAtMs,
        completedAtMs: isRequest ? null : occurredAtMs,
        modelId: text(attributes.model ?? attributes.model_name, 200),
        querySource: text(attributes.role, 100),
        finishReason: text(finishReasons.join(",") || null, 100),
        status: isRequest ? "observed" : isError ? "error" : "completed",
        durationMs: number(attributes.duration_ms ?? attributes.duration),
        inputTokens: integer(attributes.input_token_count),
        cachedInputTokens: integer(attributes.cached_content_token_count),
        outputTokens: integer(attributes.output_token_count),
        reasoningTokens: integer(attributes.thoughts_token_count),
        totalTokens: integer(attributes.total_token_count),
        stableErrorCode: isError ? "GEMINI_API_ERROR" : null
      });
      return;
    }
    const toolName = text(attributes.function_name, 256) ?? "unknown-tool";
    const callIdentity = `${promptId ?? "unknown"}:${toolName}:${attributes.start_time ?? attributes["event.timestamp"] ?? occurredAtMs}`;
    const callHash = hashIdentifier("gemini-cli-call", callIdentity);
    const completedAtMs = time(attributes.end_time) ?? occurredAtMs;
    const startedAtMs = time(attributes.start_time) ?? Math.max(0, completedAtMs - (number(attributes.duration_ms) ?? 0));
    for (const [kind, status, eventTime] of [
      ["tool-call", "observed", startedAtMs],
      ["tool-result", attributes.success === false ? "error" : "completed", completedAtMs]
    ]) {
      writes += putTraceToolEvent(database, {
        ...common,
        eventId: eventIdentifier("gemini-cli", `otel-${kind}`, sessionId, callIdentity),
        callHash,
        kind,
        occurredAtMs: eventTime,
        completedAtMs: kind === "tool-result" ? completedAtMs : null,
        toolName,
        status,
        responseBytes: kind === "tool-result" ? integer(attributes.content_length) : null,
        stableErrorCode: status === "error" ? "GEMINI_TOOL_FAILED" : null
      });
    }
  };
  return {
    project,
    writes: () => writes,
    recognized: () => recognized,
    contentFiltered: () => contentFiltered,
    providerVersion: () => observedProviderVersion
  };
}

function health(scannedAtMs) {
  return {
    ...GEMINI_OTEL_ADAPTER,
    status: "ok",
    errorCode: null,
    providerVersion: null,
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

export function scanGeminiTelemetry({ database, config, scannedAtMs, budget }) {
  const results = [];
  for (const filePath of config.geminiTelemetryLogs) {
    if (!fs.existsSync(filePath)) continue;
    let sourceStat;
    try { sourceStat = fs.lstatSync(filePath); } catch { continue; }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
    if (budget.remainingBytes <= 0 || budget.remainingLines <= 0 || Date.now() >= budget.deadlineMs) break;
    const sourceId = hashIdentifier("source:gemini-cli-otel", filePath);
    const cursor = getTraceCursor(database, sourceId);
    const identity = `${sourceStat.dev}:${sourceStat.ino}`;
    const identityMatches = cursor?.file_identity === identity;
    const sizeMatches = cursor && cursor.offset_bytes <= sourceStat.size;
    const startOffset = identityMatches && sizeMatches ? cursor.offset_bytes : 0;
    if (startOffset === sourceStat.size) continue;
    const maximumBytes = Math.min(config.limits.maxBytesPerSource, budget.remainingBytes);
    const maximumRecords = Math.min(config.limits.maxLinesPerRun, budget.remainingLines);
    const parser = geminiParser({ database, sourceId, recordedAtMs: scannedAtMs });
    const result = health(scannedAtMs);
    try {
      database.exec("BEGIN IMMEDIATE");
      const read = readJsonObjectsIncremental({
        filePath,
        startOffset,
        expectedIdentity: identityMatches ? identity : null,
        maximumBytes,
        maximumObjectBytes: config.limits.maxLineBytes,
        maximumRecords,
        maximumDepth: config.limits.maxJsonDepth,
        deadlineMs: budget.deadlineMs,
        onRecord: parser.project
      });
      putTraceCursor(database, {
        sourceId,
        adapterId: GEMINI_OTEL_ADAPTER.adapterId,
        fileIdentity: read.fileIdentity,
        offsetBytes: read.nextOffset,
        sizeBytes: read.sizeBytes,
        mtimeMs: read.mtimeMs,
        discardingLine: false,
        skippedLines: read.skippedRecords + parser.contentFiltered(),
        updatedAtMs: scannedAtMs
      });
      database.exec("COMMIT");
      budget.remainingBytes -= read.bytesRead;
      budget.remainingLines -= read.recordsRead;
      result.filesRead = 1;
      result.bytesRead = read.bytesRead;
      result.linesRead = read.recordsRead;
      result.eventsWritten = parser.writes();
      result.providerVersion = parser.providerVersion();
      result.skippedLines = read.skippedRecords + parser.contentFiltered();
      result.backlogSources = read.hasBacklog ? 1 : 0;
      if (parser.contentFiltered() > 0) {
        result.status = "partial";
        result.errorCode = "TRACE_SOURCE_CONTENT_POLICY_FILTERED";
      } else if (read.hasBacklog) result.status = "partial";
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      budget.remainingBytes = Math.max(0, budget.remainingBytes - maximumBytes);
      budget.remainingLines = Math.max(0, budget.remainingLines - maximumRecords);
      result.status = "error";
      result.errorCode = stableErrorCode(error, "GEMINI_OTEL_READ_FAILED");
    }
    putTraceAdapterHealth(database, result);
    results.push(result);
  }
  return results;
}

export { geminiParser };
