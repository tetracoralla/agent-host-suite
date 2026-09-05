import { assertPrivateFiles } from "./private-files.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashIdentifier } from "./core/hash.mjs";
import { readJsonlIncremental } from "./core/jsonl-reader.mjs";
import { ObserverError } from "./errors.mjs";
import { ZCODE_TRACE_ADAPTER } from "./providers/zcode-trace.mjs";

export const TRACE_ANALYSIS_PACK_VERSION = "openadam.agent-host-trace-analysis-pack.v0.1";
export const DEFAULT_TRACE_EXPORT_LIMITS = Object.freeze({
  maxInputBytes: 128 * 1024 * 1024,
  maxEvents: 500,
  maxLineBytes: 4 * 1024 * 1024,
  maxJsonDepth: 64,
  maxContentBytesPerEvent: 64 * 1024,
  maxOutputBytes: 16 * 1024 * 1024
});

const CREDENTIAL_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|headers|provideroptions|providermetadata)$/iu;

function timestampMs(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function serializedBytes(value) {
  if (value === undefined) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function sourceInfo(filePath, maximumBytes) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch (error) {
    throw new ObserverError("TRACE_SOURCE_UNAVAILABLE", "Trace source could not be opened as a regular local file", { cause: error?.code ?? null });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new ObserverError("TRACE_SOURCE_INVALID", "Trace source must be a regular file");
    if (stat.size > maximumBytes) return { sizeBytes: stat.size, sha256: null, identity: `${stat.dev}:${stat.ino}` };
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    return { sizeBytes: stat.size, sha256: digest.digest("hex"), identity: `${stat.dev}:${stat.ino}` };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeSelectedContent(value, state, depth = 0) {
  if (depth > 16) {
    state.truncations += 1;
    return "[TRUNCATED_DEPTH]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length > 128) state.truncations += 1;
    return value.slice(0, 128).map((item) => sanitizeSelectedContent(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value);
  const output = {};
  const entries = Object.entries(value);
  if (entries.length > 128) state.truncations += 1;
  for (const [key, item] of entries.slice(0, 128)) {
    if (CREDENTIAL_KEYS.test(key)) {
      output[key] = "[REDACTED]";
      state.redactions += 1;
    } else {
      output[key] = sanitizeSelectedContent(item, state, depth + 1);
    }
  }
  return output;
}

function boundedSelectedContent(value, state, maximumBytes) {
  const sanitized = sanitizeSelectedContent(value, state);
  const serialized = JSON.stringify(sanitized);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maximumBytes) return sanitized;
  state.truncations += 1;
  let preview = serialized.slice(0, maximumBytes);
  while (Buffer.byteLength(preview) > maximumBytes) preview = preview.slice(0, -1);
  return { truncated: true, originalUtf8Bytes: bytes, sanitizedJsonPreview: preview };
}

function selectedContent(record, state, maximumBytes) {
  const messages = Array.isArray(record.request?.messages) ? record.request.messages : [];
  const projection = {
    requestMessages: messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      return {
        role: message.role ?? null,
        content: message.content ?? null,
        toolCallId: message.toolCallId ?? null,
        toolName: message.toolName ?? null,
        isError: message.isError === true,
        toolCalls: message.toolCalls ?? null
      };
    }),
    response: {
      text: record.response?.text ?? null,
      reasoningText: record.response?.reasoningText ?? null,
      toolCalls: record.response?.toolCalls ?? [],
      finishReason: record.response?.finishReason ?? null
    },
    error: record.error === null || record.error === undefined
      ? null
      : { code: record.error?.code ?? "MODEL_REQUEST_ERROR" }
  };
  return boundedSelectedContent(projection, state, maximumBytes);
}

function projectZcodeRecord(record, ordinal, includeContent, contentState, limits) {
  if (!record || typeof record !== "object" || record.type !== "model_io") return null;
  const sessionHash = hashIdentifier("zcode-session", record.sessionId);
  const turnHash = hashIdentifier("zcode-turn", record.turnId);
  const requestHash = hashIdentifier("zcode-model-request", record.requestId);
  const toolNames = Array.isArray(record.request?.toolNames)
    ? record.request.toolNames.filter((name) => typeof name === "string" && Buffer.byteLength(name) <= 256).slice(0, 2_000)
    : [];
  const toolCalls = Array.isArray(record.response?.toolCalls) ? record.response.toolCalls : [];
  const usage = record.response?.usage && typeof record.response.usage === "object" ? record.response.usage : {};
  const event = {
    ordinal,
    kind: "model-step",
    sessionHash,
    turnHash,
    requestHash,
    startedAtMs: timestampMs(record.startedAt),
    completedAtMs: timestampMs(record.completedAt),
    facts: {
      querySource: typeof record.querySource === "string" ? record.querySource.slice(0, 100) : null,
      attempt: nonNegativeInteger(record.attempt),
      model: typeof record.model?.modelId === "string" ? record.model.modelId.slice(0, 200) : null,
      provider: typeof record.model?.providerId === "string" ? record.model.providerId.slice(0, 100) : null,
      durationMs: Number.isFinite(Number(record.durationMs)) && Number(record.durationMs) >= 0 ? Number(record.durationMs) : null,
      finishReason: typeof record.response?.finishReason === "string" ? record.response.finishReason.slice(0, 100) : null,
      status: record.error !== null && record.error !== undefined ? "error" : record.completedAt ? "completed" : "observed",
      stableErrorCode: record.error !== null && record.error !== undefined ? "MODEL_REQUEST_ERROR" : null,
      requestMessageCount: nonNegativeInteger(record.request?.messageCount) ?? messagesLength(record.request?.messages),
      requestBytes: serializedBytes(record.request),
      responseBytes: serializedBytes(record.response),
      offeredToolCount: Array.isArray(record.request?.toolNames) ? record.request.toolNames.length : null,
      offeredToolNames: toolNames,
      emittedToolCallCount: toolCalls.length,
      emittedToolCalls: toolCalls.slice(0, 256).map((call) => ({
        callHash: hashIdentifier("zcode-call", call?.id),
        toolName: typeof call?.name === "string" ? call.name.slice(0, 256) : null,
        requestBytes: serializedBytes(call?.input)
      })),
      toolResultsInRequest: (Array.isArray(record.request?.messages) ? record.request.messages : [])
        .filter((message) => message?.role === "tool")
        .slice(0, 256)
        .map((message) => ({
          callHash: hashIdentifier("zcode-call", message.toolCallId),
          toolName: typeof message.toolName === "string" ? message.toolName.slice(0, 256) : null,
          status: message.isError === true ? "error" : "completed",
          responseBytes: serializedBytes(message.content)
        })),
      usage: {
        inputTokens: nonNegativeInteger(usage.inputTokens),
        cachedInputTokens: nonNegativeInteger(usage.cacheReadTokens),
        outputTokens: nonNegativeInteger(usage.outputTokens),
        totalTokens: nonNegativeInteger(usage.totalTokens)
      },
      selfReportedRationalePresent: typeof record.response?.reasoningText === "string"
        ? record.response.reasoningText.length > 0
        : null
    }
  };
  if (includeContent) event.selectedContent = selectedContent(record, contentState, limits.maxContentBytesPerEvent);
  return event;
}

function messagesLength(value) {
  return Array.isArray(value) ? value.length : null;
}

function serializedPack(pack) {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function fitTraceOutputBudget(pack, maximumBytes, prepareForSerialization = null) {
  const serialize = () => {
    if (prepareForSerialization !== null) prepareForSerialization(pack);
    return serializedPack(pack);
  };
  let serialized = serialize();
  if (Buffer.byteLength(serialized) <= maximumBytes) return serialized;
  pack.limits.outputTruncated = true;
  const originalEvents = pack.events;
  let low = 0;
  let high = originalEvents.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    pack.events = originalEvents.slice(0, middle);
    pack.limits.eventsReturned = pack.events.length;
    serialized = serialize();
    if (Buffer.byteLength(serialized) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  pack.events = originalEvents.slice(0, low);
  pack.limits.eventsReturned = pack.events.length;
  serialized = serialize();
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new ObserverError("TRACE_OUTPUT_BUDGET_TOO_SMALL", "Trace output budget cannot contain the required analysis-pack envelope");
  }
  return serialized;
}

export function writeTraceOutputExclusive(filePath, contents) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new ObserverError("TRACE_OUTPUT_INVALID", "Trace analysis output must be one explicit file path");
  }
  const destination = path.resolve(filePath);
  if (fs.existsSync(destination)) throw new ObserverError("TRACE_OUTPUT_EXISTS", "Trace analysis output already exists");
  const parent = path.dirname(destination);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (error) {
    throw new ObserverError("TRACE_OUTPUT_DIRECTORY_INVALID", "Trace analysis output directory must be an existing real directory", { cause: error?.code ?? null });
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new ObserverError("TRACE_OUTPUT_DIRECTORY_INVALID", "Trace analysis output directory must be a real directory");
  }
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`);
  let descriptor = null;
  let destinationCreated = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    assertPrivateFiles([{ path: temporary, ensure: true }], "TRACE_OUTPUT_PERMISSIONS");
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error?.code)) throw error;
      fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
    }
    destinationCreated = true;
    const destinationStat = fs.lstatSync(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new ObserverError("TRACE_OUTPUT_INVALID", "Trace analysis output must be a regular non-symlinked file");
    }
    assertPrivateFiles([{ path: destination, ensure: true }], "TRACE_OUTPUT_PERMISSIONS");
    const destinationDescriptor = fs.openSync(destination, fs.constants.O_RDWR);
    try {
      fs.fsyncSync(destinationDescriptor);
    } finally {
      fs.closeSync(destinationDescriptor);
    }
  } catch (error) {
    if (destinationCreated) fs.rmSync(destination, { force: true });
    if (error?.code === "EEXIST") throw new ObserverError("TRACE_OUTPUT_EXISTS", "Trace analysis output already exists");
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  return destination;
}

export function exportTraceAnalysisPack(options) {
  if (options.provider !== "zcode") {
    throw new ObserverError("TRACE_PROVIDER_UNSUPPORTED", "Trace analysis export currently supports provider zcode");
  }
  if (options.includeSelectedContent && !options.confirmSensitiveContent) {
    throw new ObserverError("TRACE_CONTENT_CONFIRMATION_REQUIRED", "Selected content export requires --confirm-sensitive-content");
  }
  if (!options.includeSelectedContent && options.confirmSensitiveContent) {
    throw new ObserverError("TRACE_CONTENT_CONFIRMATION_UNUSED", "--confirm-sensitive-content requires --include-selected-content");
  }
  const limits = { ...DEFAULT_TRACE_EXPORT_LIMITS, ...(options.limits ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ObserverError("TRACE_LIMIT_INVALID", `${name} must be a positive integer`);
  }
  const sourcePath = path.resolve(options.file);
  const outputPath = path.resolve(options.output);
  if (sourcePath === outputPath) throw new ObserverError("TRACE_OUTPUT_INVALID", "Trace output must differ from its source");
  const info = sourceInfo(sourcePath, limits.maxInputBytes);
  const events = [];
  const sessions = new Set();
  const contentState = { redactions: 0, truncations: 0 };
  const read = readJsonlIncremental({
    filePath: sourcePath,
    startOffset: 0,
    discardingLine: false,
    expectedIdentity: info.identity,
    maximumBytes: limits.maxInputBytes,
    maximumLineBytes: limits.maxLineBytes,
    maximumLines: limits.maxEvents,
    maximumDepth: limits.maxJsonDepth,
    deadlineMs: Date.now() + 60_000,
    onRecord(record) {
      const projected = projectZcodeRecord(record, events.length, options.includeSelectedContent === true, contentState, limits);
      if (projected === null) return;
      events.push(projected);
      if (projected.sessionHash !== null) sessions.add(projected.sessionHash);
    }
  });
  const pack = {
    schemaVersion: TRACE_ANALYSIS_PACK_VERSION,
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    source: {
      provider: "zcode",
      adapterId: ZCODE_TRACE_ADAPTER.adapterId,
      adapterVersion: ZCODE_TRACE_ADAPTER.adapterVersion,
      sourceFormat: ZCODE_TRACE_ADAPTER.sourceFormat,
      sourceBytes: info.sizeBytes,
      sourceSha256: info.sha256,
      sessionHashes: [...sessions].sort()
    },
    privacy: {
      contentPolicy: options.includeSelectedContent ? "selected-content" : "metadata-only",
      selectedConversationContentIncluded: options.includeSelectedContent === true,
      sensitiveContentConfirmed: options.confirmSensitiveContent === true,
      transportSecretsExcluded: true,
      selectedContentMayContainUserSecrets: options.includeSelectedContent === true,
      observerDatabaseRetention: false,
      sourcePathIncluded: false,
      credentialFieldsRedacted: contentState.redactions
    },
    limits: {
      maxInputBytes: limits.maxInputBytes,
      maxEvents: limits.maxEvents,
      maxLineBytes: limits.maxLineBytes,
      maxContentBytesPerEvent: limits.maxContentBytesPerEvent,
      maxOutputBytes: limits.maxOutputBytes,
      inputTruncated: read.hasBacklog && read.bytesRead >= limits.maxInputBytes,
      eventLimitReached: read.hasBacklog && read.linesRead >= limits.maxEvents,
      outputTruncated: false,
      skippedLines: read.skippedLines,
      contentTruncations: contentState.truncations,
      eventsReturned: events.length
    },
    events,
    unknowns: [
      "authoritative-skill-activation",
      "semantic-correctness",
      "result-adoption",
      "non-use-reason",
      "task-quality",
      "product-opportunity"
    ],
    interpretationStatus: "not-performed"
  };
  const serialized = fitTraceOutputBudget(pack, limits.maxOutputBytes);
  const writtenPath = writeTraceOutputExclusive(outputPath, serialized);
  return {
    status: "completed",
    schemaVersion: TRACE_ANALYSIS_PACK_VERSION,
    outputPath: writtenPath,
    outputBytes: Buffer.byteLength(serialized),
    eventsReturned: pack.events.length,
    contentPolicy: pack.privacy.contentPolicy,
    observerDatabaseRetention: false,
    sourcePathStoredInPack: false,
    interpretationStatus: "not-performed"
  };
}
