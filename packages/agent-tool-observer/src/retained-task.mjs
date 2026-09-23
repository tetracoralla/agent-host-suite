import { createHash } from "node:crypto";
import { ObserverError } from "./errors.mjs";
import { fitTraceOutputBudget, writeTraceOutputExclusive } from "./trace-export.mjs";
import {
  assertRetainedTaskSchema,
  readRetainedTaskRows,
  readRetainedTaskSourceRows,
  readRetainedTaskSummary
} from "./retained-task-query.mjs";

export const TASK_SOURCE_CATALOG_VERSION = "openadam.agent-host-task-source-catalog.v0.1";
export const RETAINED_TASK_PACK_VERSION = "openadam.agent-host-task-activity-pack.v0.1";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UNKNOWN_INTERPRETATIONS = Object.freeze([
  "authoritative-skill-activation",
  "nested-reference-execution",
  "semantic-correctness",
  "result-adoption",
  "discovery-cause",
  "task-quality",
  "comparative-value"
]);

function assertProvider(provider) {
  if (typeof provider !== "string" || !PROVIDER.test(provider)) {
    throw new ObserverError("TASK_PROVIDER_INVALID", "Task provider must be a lowercase provider identifier");
  }
}

function assertSessionHash(sessionHash) {
  if (typeof sessionHash !== "string" || !SESSION_HASH.test(sessionHash)) {
    throw new ObserverError("TASK_SESSION_INVALID", "Task session must be a 64-character lowercase hexadecimal hash");
  }
}

function normalizeRange(options) {
  const fromMs = options.fromMs ?? null;
  const toMs = options.toMs ?? null;
  for (const [name, value] of [["fromMs", fromMs], ["toMs", toMs]]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ObserverError("TASK_RANGE_INVALID", `${name} must be a non-negative safe integer`);
    }
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new ObserverError("TASK_RANGE_INVALID", "Task range start must not be after its end");
  }
  return { fromMs, toMs };
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ObserverError("TASK_LIMIT_INVALID", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function retention(config, nowMs) {
  return {
    retentionDays: config.limits.retentionDays,
    currentCutoffMs: Math.max(0, nowMs - config.limits.retentionDays * DAY_MS),
    eventsBeforeCutoffMayHaveBeenRemoved: true,
    collectionBeforeMonitoringWasEnabled: "unavailable"
  };
}

function privacy() {
  return {
    contentPolicy: "metadata-only",
    sourcePathIncluded: false,
    rawConversationContentIncluded: false,
    toolArgumentsIncluded: false,
    toolResultsIncluded: false
  };
}

function sourceProjection(row) {
  return {
    sessionHash: row.session_hash,
    sessionStartedAtMs: row.session_started_at_ms,
    firstEventAtMs: row.first_event_at_ms,
    lastEventAtMs: row.last_event_at_ms,
    observedTurns: row.observed_turns,
    toolObservations: row.tool_observations,
    directCalls: row.direct_calls,
    staticReferences: row.static_references,
    completed: row.completed,
    errors: row.errors,
    cancelled: row.cancelled,
    outcomeUnknown: row.outcome_unknown,
    usageRecords: row.usage_records,
    completeness: "unknown"
  };
}

export function listRetainedTaskSources(database, config, options = {}) {
  assertProvider(options.provider);
  const range = normalizeRange(options);
  const maximum = boundedInteger(options.limit, 50, 1, 500, "limit");
  assertRetainedTaskSchema(database);
  const rows = readRetainedTaskSourceRows(database, options.provider, range, maximum + 1);
  const sources = rows.slice(0, maximum).map(sourceProjection);
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: TASK_SOURCE_CATALOG_VERSION,
    status: "ok",
    generatedAt: new Date(nowMs).toISOString(),
    provider: options.provider,
    requestedRange: range,
    retention: retention(config, nowMs),
    privacy: privacy(),
    limits: {
      maxSources: maximum,
      sourceLimitReached: rows.length > maximum,
      sourcesReturned: sources.length
    },
    sources,
    observationBoundary: {
      directCallsAreExecutionObservations: true,
      staticReferencesAreExecutionObservations: false,
      terminalStatusMayBePartial: true
    },
    unknowns: [...UNKNOWN_INTERPRETATIONS],
    interpretationStatus: "not-performed"
  };
}

function eventHash(value) {
  return createHash("sha256").update(`task-event:${value}`).digest("hex");
}

function projectEvent(row, ordinal) {
  const common = {
    ordinal,
    kind: row.event_kind,
    eventHash: eventHash(row.event_id),
    sessionHash: row.session_hash,
    turnHash: row.turn_hash,
    callHash: row.call_hash,
    occurredAtMs: row.occurred_at_ms,
    completedAtMs: row.completed_at_ms,
    sourceFormat: row.source_format
  };
  if (row.event_kind === "tool-observation") {
    return {
      ...common,
      facts: {
        observationClass: row.derived === 1 ? "static-reference" : "direct-execution-observation",
        toolName: row.tool_name,
        toolNamespace: row.tool_namespace,
        routeClass: row.route_class,
        isOpenAdam: row.is_openadam === 1,
        status: row.status,
        durationMs: row.duration_ms,
        retryCount: row.retry_count,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes
      }
    };
  }
  return {
    ...common,
    facts: {
      durationMs: row.duration_ms,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens
    }
  };
}

export function exportRetainedTaskActivityPack(database, config, options = {}) {
  assertProvider(options.provider);
  assertSessionHash(options.sessionHash);
  if (typeof options.output !== "string" || options.output.length === 0) {
    throw new ObserverError("TASK_OUTPUT_INVALID", "Task activity output must be one explicit file path");
  }
  const range = normalizeRange(options);
  const maxEvents = boundedInteger(options.maxEvents, 500, 1, 5_000, "maxEvents");
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, 16 * 1024 * 1024, 4_096, 64 * 1024 * 1024, "maxOutputBytes");
  assertRetainedTaskSchema(database);
  const summary = readRetainedTaskSummary(database, options.provider, range, options.sessionHash);
  if (summary === null) {
    const anyRange = readRetainedTaskSummary(database, options.provider, { fromMs: null, toMs: null }, options.sessionHash);
    if (anyRange === null) throw new ObserverError("TASK_SESSION_NOT_FOUND", "No retained task metadata matches this provider and session");
    throw new ObserverError("TASK_SESSION_RANGE_EMPTY", "The retained task has no events in the requested time range");
  }
  const rows = readRetainedTaskRows(database, options.provider, range, options.sessionHash, maxEvents + 1);
  const events = rows.slice(0, maxEvents).map(projectEvent);
  const nowMs = options.nowMs ?? Date.now();
  const pack = {
    schemaVersion: RETAINED_TASK_PACK_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      provider: options.provider,
      selectionKind: "observer-retained-task-session",
      sessionHash: options.sessionHash,
      requestedRange: range,
      retainedRange: {
        sessionStartedAtMs: summary.session_started_at_ms,
        firstEventAtMs: summary.first_event_at_ms,
        lastEventAtMs: summary.last_event_at_ms
      },
      observedTurns: summary.observed_turns,
      retainedEventCount: summary.event_count,
      completeness: "unknown"
    },
    privacy: {
      ...privacy(),
      observerPackRetained: false,
      sourceUsesObserverRetainedMetadata: true
    },
    retention: retention(config, nowMs),
    limits: {
      maxEvents,
      maxOutputBytes,
      eventLimitReached: rows.length > maxEvents,
      outputTruncated: false,
      eventsAvailable: summary.event_count,
      eventsReturned: events.length
    },
    observations: sourceProjection(summary),
    events,
    observationBoundary: {
      directCallsAreExecutionObservations: true,
      staticReferencesAreExecutionObservations: false,
      nestedChildReceiptsRequireAProviderTraceOrComponentReceipt: true,
      adoptionNotRepresented: true
    },
    unknowns: [...UNKNOWN_INTERPRETATIONS],
    interpretationStatus: "not-performed"
  };
  const serialized = fitTraceOutputBudget(pack, maxOutputBytes);
  const outputPath = writeTraceOutputExclusive(options.output, serialized);
  return {
    status: "completed",
    schemaVersion: RETAINED_TASK_PACK_VERSION,
    outputPath,
    outputBytes: Buffer.byteLength(serialized),
    eventsReturned: pack.events.length,
    eventsAvailable: summary.event_count,
    contentPolicy: "metadata-only",
    observerPackRetained: false,
    interpretationStatus: "not-performed"
  };
}
