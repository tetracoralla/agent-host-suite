import path from "node:path";
import { nonNegativeInteger } from "../core/classify.mjs";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { discoverJsonlFiles, readJsonlIncremental } from "../core/jsonl-reader.mjs";
import {
  getTraceCursor,
  putTraceCursor,
  putTraceModelStep,
  putTraceToolEvent,
  putTraceToolOffer
} from "../db.mjs";
import { stableErrorCode } from "../errors.mjs";

export const ZCODE_TRACE_ADAPTER = Object.freeze({
  adapterId: "openadam.zcode-model-io",
  adapterVersion: "0.1.0",
  provider: "zcode",
  transport: "stable-local-records",
  sourceFormat: "zcode-model-io-jsonl"
});

function timestampMs(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function finiteNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function boundedString(value, maximumBytes) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximumBytes) return null;
  return value;
}

function serializedBytes(value) {
  if (value === undefined) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function requestStatus(record) {
  if (record.error !== null && record.error !== undefined) return "error";
  const reason = String(record.response?.finishReason ?? "").toLowerCase();
  if (["cancelled", "canceled", "aborted"].includes(reason)) return "cancelled";
  return record.completedAt === null || record.completedAt === undefined ? "observed" : "completed";
}

function traceIdentity(record, sourceId) {
  const sessionId = boundedString(record.sessionId, 1_024);
  const turnId = boundedString(record.turnId, 1_024);
  const requestId = boundedString(record.requestId, 1_024);
  const fallback = `${sourceId}:${record.startedAt ?? ""}:${record.attempt ?? ""}`;
  return {
    sessionId,
    turnId,
    requestId,
    eventId: eventIdentifier("zcode", "model-step", sessionId, turnId, requestId ?? fallback),
    sessionHash: hashIdentifier("zcode-session", sessionId),
    turnHash: hashIdentifier("zcode-turn", turnId),
    requestHash: hashIdentifier("zcode-model-request", requestId ?? fallback)
  };
}

function createZcodeTraceParser({ database, sourceId, recordedAtMs }) {
  let writes = 0;
  return {
    onRecord(record) {
      if (!record || typeof record !== "object" || record.type !== "model_io") return;
      const identity = traceIdentity(record, sourceId);
      const startedAtMs = timestampMs(record.startedAt);
      const completedAtMs = timestampMs(record.completedAt);
      const toolNames = Array.isArray(record.request?.toolNames)
        ? [...new Set(record.request.toolNames.filter((name) => boundedString(name, 256) !== null))].slice(0, 2_000)
        : [];
      const toolCalls = Array.isArray(record.response?.toolCalls)
        ? record.response.toolCalls.filter((call) => call && typeof call === "object")
        : [];
      const usage = record.response?.usage && typeof record.response.usage === "object" ? record.response.usage : {};
      const modelId = boundedString(record.model?.modelId, 200) ?? boundedString(record.response?.modelId, 200);
      const status = requestStatus(record);
      writes += putTraceModelStep(database, {
        ...identity,
        provider: ZCODE_TRACE_ADAPTER.provider,
        adapterId: ZCODE_TRACE_ADAPTER.adapterId,
        adapterVersion: ZCODE_TRACE_ADAPTER.adapterVersion,
        providerVersion: null,
        sourceId,
        occurredAtMs: startedAtMs,
        completedAtMs,
        modelId,
        querySource: boundedString(record.querySource, 100),
        finishReason: boundedString(record.response?.finishReason, 100),
        status,
        attempt: nonNegativeInteger(record.attempt),
        durationMs: finiteNonNegativeNumber(record.durationMs),
        requestBytes: serializedBytes(record.request),
        responseBytes: serializedBytes(record.response),
        requestMessageCount: nonNegativeInteger(record.request?.messageCount)
          ?? (Array.isArray(record.request?.messages) ? record.request.messages.length : null),
        offeredToolCount: Array.isArray(record.request?.toolNames) ? record.request.toolNames.length : null,
        emittedToolCallCount: Array.isArray(record.response?.toolCalls) ? record.response.toolCalls.length : null,
        inputTokens: nonNegativeInteger(usage.inputTokens),
        cachedInputTokens: nonNegativeInteger(usage.cacheReadTokens),
        outputTokens: nonNegativeInteger(usage.outputTokens),
        reasoningTokens: null,
        totalTokens: nonNegativeInteger(usage.totalTokens),
        rationalePresent: typeof record.response?.reasoningText === "string"
          ? record.response.reasoningText.length > 0
          : null,
        stableErrorCode: status === "error" ? "MODEL_REQUEST_ERROR" : null,
        sourceFormat: ZCODE_TRACE_ADAPTER.sourceFormat,
        recordedAtMs
      });
      for (const toolName of toolNames) {
        writes += putTraceToolOffer(database, { eventId: identity.eventId, toolName });
      }
      for (const [index, call] of toolCalls.entries()) {
        const callId = boundedString(call.id, 1_024) ?? `${identity.requestId ?? identity.eventId}:${index}`;
        const toolName = boundedString(call.name, 256);
        if (toolName === null) continue;
        writes += putTraceToolEvent(database, {
          eventId: eventIdentifier("zcode", "trace-tool-call", identity.sessionId, callId),
          provider: ZCODE_TRACE_ADAPTER.provider,
          adapterId: ZCODE_TRACE_ADAPTER.adapterId,
          adapterVersion: ZCODE_TRACE_ADAPTER.adapterVersion,
          sourceId,
          sessionHash: identity.sessionHash,
          turnHash: identity.turnHash,
          requestHash: identity.requestHash,
          callHash: hashIdentifier("zcode-call", callId),
          kind: "tool-call",
          occurredAtMs: completedAtMs ?? startedAtMs,
          completedAtMs: null,
          toolName,
          status: "observed",
          requestBytes: serializedBytes(call.input),
          responseBytes: null,
          stableErrorCode: null,
          sourceFormat: ZCODE_TRACE_ADAPTER.sourceFormat,
          recordedAtMs
        });
      }
      const messages = Array.isArray(record.request?.messages) ? record.request.messages : [];
      for (const message of messages) {
        if (!message || typeof message !== "object" || message.role !== "tool") continue;
        const callId = boundedString(message.toolCallId, 1_024);
        const toolName = boundedString(message.toolName, 256);
        if (callId === null || toolName === null) continue;
        writes += putTraceToolEvent(database, {
          eventId: eventIdentifier("zcode", "trace-tool-result", identity.sessionId, callId),
          provider: ZCODE_TRACE_ADAPTER.provider,
          adapterId: ZCODE_TRACE_ADAPTER.adapterId,
          adapterVersion: ZCODE_TRACE_ADAPTER.adapterVersion,
          sourceId,
          sessionHash: identity.sessionHash,
          turnHash: identity.turnHash,
          requestHash: identity.requestHash,
          callHash: hashIdentifier("zcode-call", callId),
          kind: "tool-result",
          occurredAtMs: null,
          completedAtMs: null,
          toolName,
          status: message.isError === true ? "error" : "completed",
          requestBytes: null,
          responseBytes: serializedBytes(message.content),
          stableErrorCode: message.isError === true ? "TOOL_RESULT_ERROR" : null,
          sourceFormat: ZCODE_TRACE_ADAPTER.sourceFormat,
          recordedAtMs
        });
      }
    },
    eventsWritten() {
      return writes;
    }
  };
}

function emptyHealth(scannedAtMs) {
  return {
    ...ZCODE_TRACE_ADAPTER,
    status: "ok",
    errorCode: null,
    providerVersion: null,
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

export function scanZcodeTrace({ database, config, minimumMtimeMs, scannedAtMs, budget }) {
  const health = emptyHealth(scannedAtMs);
  let discovery;
  try {
    discovery = discoverJsonlFiles(config.zcodeTraceRoots, {
      maximumFiles: config.limits.maxFilesPerProvider,
      minimumMtimeMs,
      acceptFileName: (name) => name.startsWith("model-io-")
    });
  } catch (error) {
    return { ...health, status: "error", errorCode: stableErrorCode(error, "SOURCE_DISCOVERY_FAILED") };
  }
  const files = discovery.files.filter((file) => path.basename(file.filePath).startsWith("model-io-") && path.extname(file.filePath) === ".jsonl");
  health.filesSeen = files.length;
  if (discovery.presentRoots === 0) return { ...health, status: "missing", errorCode: "SOURCE_ROOT_MISSING" };
  if (files.length === 0) return { ...health, status: "missing", errorCode: "SOURCE_TRACE_MISSING" };
  if (discovery.truncated || discovery.skippedSymlinks > 0) health.status = "partial";
  let failures = 0;
  const scheduledFiles = files
    .map((file) => ({
      file,
      sourceId: hashIdentifier("source:zcode-model-io", file.filePath),
      cursor: null
    }))
    .map((candidate) => ({ ...candidate, cursor: getTraceCursor(database, candidate.sourceId) }))
    .sort((left, right) => {
      const leftUpdated = left.cursor?.updated_at_ms ?? -1;
      const rightUpdated = right.cursor?.updated_at_ms ?? -1;
      return leftUpdated - rightUpdated
        || left.file.sizeBytes - right.file.sizeBytes
        || right.file.mtimeMs - left.file.mtimeMs
        || left.file.filePath.localeCompare(right.file.filePath);
    });
  for (const [fileIndex, candidate] of scheduledFiles.entries()) {
    const { file, sourceId, cursor } = candidate;
    if (budget.remainingBytes <= 0 || budget.remainingLines <= 0 || Date.now() >= budget.deadlineMs) {
      health.status = "partial";
      health.backlogSources += 1;
      continue;
    }
    const identityMatches = cursor?.file_identity === file.fileIdentity;
    const sizeMatches = cursor && cursor.offset_bytes <= file.sizeBytes;
    const startOffset = identityMatches && sizeMatches ? cursor.offset_bytes : 0;
    const discardingLine = identityMatches && sizeMatches && cursor.discarding_line === 1;
    if (startOffset === file.sizeBytes && !discardingLine) continue;
    const parser = createZcodeTraceParser({ database, sourceId, recordedAtMs: scannedAtMs });
    const filesRemaining = scheduledFiles.length - fileIndex;
    const fairBytes = Math.max(config.limits.maxLineBytes + 1, Math.floor(budget.remainingBytes / filesRemaining));
    const fairLines = Math.max(1, Math.floor(budget.remainingLines / filesRemaining));
    const maximumBytes = Math.min(config.limits.maxBytesPerSource, budget.remainingBytes, fairBytes);
    const maximumLines = Math.min(config.limits.maxLinesPerRun, budget.remainingLines, fairLines);
    try {
      database.exec("BEGIN IMMEDIATE");
      const result = readJsonlIncremental({
        filePath: file.filePath,
        startOffset,
        discardingLine,
        expectedIdentity: identityMatches ? file.fileIdentity : null,
        maximumBytes,
        maximumLineBytes: config.limits.maxLineBytes,
        maximumLines,
        maximumDepth: config.limits.maxJsonDepth,
        deadlineMs: budget.deadlineMs,
        onRecord: parser.onRecord
      });
      putTraceCursor(database, {
        sourceId,
        adapterId: ZCODE_TRACE_ADAPTER.adapterId,
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
      health.eventsWritten += parser.eventsWritten();
      health.skippedLines += result.skippedLines;
      if (result.hasBacklog) health.backlogSources += 1;
      budget.remainingBytes -= result.bytesRead;
      budget.remainingLines -= result.linesRead;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      budget.remainingBytes = Math.max(0, budget.remainingBytes - maximumBytes);
      budget.remainingLines = Math.max(0, budget.remainingLines - maximumLines);
      failures += 1;
      health.errorCode ??= stableErrorCode(error);
    }
  }
  if (failures > 0) health.status = health.filesRead > 0 ? "partial" : "error";
  if (health.skippedLines > 0 || health.backlogSources > 0) health.status = health.status === "error" ? "error" : "partial";
  return health;
}

export { createZcodeTraceParser };
