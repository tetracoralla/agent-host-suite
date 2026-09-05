import { createHash } from "node:crypto";
import { ObserverError } from "./errors.mjs";
import { fitTraceOutputBudget, writeTraceOutputExclusive } from "./trace-export.mjs";
import {
  assertRetainedTraceSchema,
  readRetainedTraceOffers,
  readRetainedTraceRows,
  readRetainedTraceSourceRows,
  readRetainedTraceSummary
} from "./retained-trace-query.mjs";

export const TRACE_SOURCE_CATALOG_VERSION = "openadam.agent-host-trace-source-catalog.v0.1";
export const RETAINED_TRACE_PACK_VERSION = "openadam.agent-host-trace-analysis-pack.v0.2";
export const DEFAULT_RETAINED_TRACE_LIMITS = Object.freeze({
  maxSources: 50,
  maxEvents: 500,
  maxOfferedToolsPerStep: 512,
  maxOutputBytes: 16 * 1024 * 1024
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UNKNOWN_INTERPRETATIONS = Object.freeze([
  "authoritative-skill-activation",
  "semantic-correctness",
  "result-adoption",
  "non-use-reason",
  "task-quality",
  "product-opportunity"
]);

function assertProvider(provider) {
  if (typeof provider !== "string" || !PROVIDER.test(provider)) {
    throw new ObserverError("TRACE_PROVIDER_INVALID", "Trace provider must be a lowercase provider identifier");
  }
}

function assertSessionHash(sessionHash) {
  if (typeof sessionHash !== "string" || !SESSION_HASH.test(sessionHash)) {
    throw new ObserverError("TRACE_SESSION_INVALID", "Trace session must be a 64-character lowercase hexadecimal hash");
  }
}

function normalizeRange(options) {
  const fromMs = options.fromMs ?? null;
  const toMs = options.toMs ?? null;
  for (const [name, value] of [["fromMs", fromMs], ["toMs", toMs]]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ObserverError("TRACE_RANGE_INVALID", `${name} must be a non-negative safe integer`);
    }
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new ObserverError("TRACE_RANGE_INVALID", "Trace range start must not be after its end");
  }
  return { fromMs, toMs };
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ObserverError("TRACE_LIMIT_INVALID", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

export function listRetainedTraceSources(database, config, options = {}) {
  assertProvider(options.provider);
  const range = normalizeRange(options);
  const maximum = boundedInteger(options.limit, DEFAULT_RETAINED_TRACE_LIMITS.maxSources, 1, 500, "limit");
  assertRetainedTraceSchema(database);
  const rows = readRetainedTraceSourceRows(database, options.provider, range, maximum + 1);
  const limited = rows.length > maximum;
  const sources = rows.slice(0, maximum).map((row) => ({
    sessionHash: row.session_hash,
    firstEventAtMs: row.first_event_at_ms,
    lastEventAtMs: row.last_event_at_ms,
    totalEvents: row.total_events,
    modelSteps: row.model_steps,
    toolCalls: row.tool_calls,
    toolResults: row.tool_results,
    turnEnds: row.turn_ends,
    completeness: "unknown"
  }));
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: TRACE_SOURCE_CATALOG_VERSION,
    status: "ok",
    generatedAt: new Date(nowMs).toISOString(),
    provider: options.provider,
    requestedRange: range,
    retention: {
      retentionDays: config.limits.retentionDays,
      currentCutoffMs: Math.max(0, nowMs - config.limits.retentionDays * DAY_MS),
      eventsBeforeCutoffMayHaveBeenRemoved: true,
      collectionBeforeMonitoringWasEnabled: "unavailable"
    },
    privacy: {
      contentPolicy: "metadata-only",
      sourcePathIncluded: false,
      rawConversationContentIncluded: false,
      toolArgumentsIncluded: false,
      toolResultsIncluded: false
    },
    limits: {
      maxSources: maximum,
      sourceLimitReached: limited,
      sourcesReturned: sources.length
    },
    sources,
    unknowns: [...UNKNOWN_INTERPRETATIONS],
    interpretationStatus: "not-performed"
  };
}

function internOfferedToolCatalog(retainedOffers, catalogs) {
  const catalog = {
    offeredToolsReturned: retainedOffers.values.length,
    offeredToolsTruncated: retainedOffers.totalStored > retainedOffers.values.length,
    tools: retainedOffers.values
  };
  const catalogHash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  if (!catalogs.has(catalogHash)) catalogs.set(catalogHash, { catalogHash, ...catalog });
  return catalogHash;
}

function retainReferencedToolCatalogs(pack, allCatalogs) {
  const referenced = new Set(pack.events
    .filter((event) => event.kind === "model-step")
    .map((event) => event.facts.offeredToolCatalogHash));
  pack.offeredToolCatalogs = allCatalogs.filter((catalog) => referenced.has(catalog.catalogHash));
}

function projectEvent(row, ordinal, offers, offeredToolCatalogs) {
  const common = {
    ordinal,
    kind: row.event_kind,
    eventHash: row.event_id,
    sessionHash: row.session_hash,
    turnHash: row.turn_hash,
    requestHash: row.request_hash,
    callHash: row.call_hash,
    occurredAtMs: row.occurred_at_ms,
    completedAtMs: row.completed_at_ms,
    adapter: {
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      providerVersion: row.provider_version,
      sourceFormat: row.source_format
    }
  };
  if (row.event_kind === "model-step") {
    const retainedOffers = offers.get(row.event_id) ?? { values: [], totalStored: 0 };
    return {
      ...common,
      facts: {
        modelId: row.model_id,
        querySource: row.query_source,
        finishReason: row.finish_reason,
        status: row.status,
        attempt: row.attempt,
        durationMs: row.duration_ms,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes,
        requestMessageCount: row.request_message_count,
        offeredToolCount: row.offered_tool_count,
        offeredToolCatalogHash: internOfferedToolCatalog(retainedOffers, offeredToolCatalogs),
        emittedToolCallCount: row.emitted_tool_call_count,
        usage: {
          inputTokens: row.input_tokens,
          cachedInputTokens: row.cached_input_tokens,
          outputTokens: row.output_tokens,
          reasoningTokens: row.reasoning_tokens,
          totalTokens: row.total_tokens
        },
        selfReportedRationalePresent: row.rationale_present === null ? null : row.rationale_present === 1,
        stableErrorCode: row.stable_error_code
      }
    };
  }
  if (row.event_kind === "tool-call" || row.event_kind === "tool-result") {
    return {
      ...common,
      facts: {
        toolName: row.tool_name,
        toolNamespace: row.tool_namespace,
        routeClass: row.route_class,
        isOpenAdam: row.is_openadam === 1,
        status: row.status,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes,
        stableErrorCode: row.stable_error_code
      }
    };
  }
  return {
    ...common,
    facts: {
      status: row.status,
      stableReason: row.stable_reason,
      stableErrorCode: row.stable_error_code
    }
  };
}

export function exportRetainedTraceAnalysisPack(database, config, options = {}) {
  assertProvider(options.provider);
  assertSessionHash(options.sessionHash);
  if (options.includeSelectedContent || options.confirmSensitiveContent) {
    throw new ObserverError("TRACE_CONTENT_UNAVAILABLE", "Observer-retained sessions contain metadata only; selected content cannot be exported");
  }
  if (typeof options.output !== "string" || options.output.length === 0) {
    throw new ObserverError("TRACE_OUTPUT_INVALID", "Trace analysis output must be one explicit file path");
  }
  const range = normalizeRange(options);
  const maxEvents = boundedInteger(options.maxEvents, DEFAULT_RETAINED_TRACE_LIMITS.maxEvents, 1, 5_000, "maxEvents");
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_RETAINED_TRACE_LIMITS.maxOutputBytes, 4_096, 64 * 1024 * 1024, "maxOutputBytes");
  const maxOfferedToolsPerStep = boundedInteger(
    options.maxOfferedToolsPerStep,
    DEFAULT_RETAINED_TRACE_LIMITS.maxOfferedToolsPerStep,
    1,
    2_000,
    "maxOfferedToolsPerStep"
  );
  assertRetainedTraceSchema(database);
  const summary = readRetainedTraceSummary(database, options.provider, range, options.sessionHash);
  if (summary === null) {
    const anyRange = readRetainedTraceSummary(database, options.provider, { fromMs: null, toMs: null }, options.sessionHash);
    if (anyRange === null) throw new ObserverError("TRACE_SESSION_NOT_FOUND", "No retained trace metadata matches this provider and session");
    throw new ObserverError("TRACE_SESSION_RANGE_EMPTY", "The retained session has no events in the requested time range");
  }
  const rows = readRetainedTraceRows(database, options.provider, range, options.sessionHash, maxEvents + 1);
  const eventLimitReached = rows.length > maxEvents;
  const selected = rows.slice(0, maxEvents);
  const modelStepIds = selected.filter((row) => row.event_kind === "model-step").map((row) => row.event_id);
  const offers = readRetainedTraceOffers(database, modelStepIds, maxOfferedToolsPerStep);
  const offeredToolCatalogs = new Map();
  const events = selected.map((row, ordinal) => projectEvent(row, ordinal, offers, offeredToolCatalogs));
  const allOfferedToolCatalogs = [...offeredToolCatalogs.values()];
  const nowMs = options.nowMs ?? Date.now();
  const pack = {
    schemaVersion: RETAINED_TRACE_PACK_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      provider: options.provider,
      selectionKind: "observer-retained-session",
      sessionHash: options.sessionHash,
      requestedRange: range,
      retainedRange: {
        firstEventAtMs: summary.firstEventAtMs,
        lastEventAtMs: summary.lastEventAtMs
      },
      retainedEventCount: summary.eventCount,
      adapters: summary.adapters,
      completeness: "unknown"
    },
    privacy: {
      contentPolicy: "metadata-only",
      selectedConversationContentIncluded: false,
      sensitiveContentConfirmed: false,
      transportSecretsExcluded: true,
      selectedContentMayContainUserSecrets: false,
      observerPackRetained: false,
      sourceUsesObserverRetainedMetadata: true,
      sourcePathIncluded: false,
      toolArgumentsIncluded: false,
      toolResultsIncluded: false
    },
    retention: {
      retentionDays: config.limits.retentionDays,
      currentCutoffMs: Math.max(0, nowMs - config.limits.retentionDays * DAY_MS),
      eventsBeforeCutoffMayHaveBeenRemoved: true,
      collectionBeforeMonitoringWasEnabled: "unavailable"
    },
    limits: {
      maxEvents,
      maxOfferedToolsPerStep,
      maxOutputBytes,
      eventLimitReached,
      outputTruncated: false,
      eventsAvailable: summary.eventCount,
      eventsReturned: events.length
    },
    offeredToolCatalogs: allOfferedToolCatalogs,
    events,
    unknowns: [...UNKNOWN_INTERPRETATIONS],
    interpretationStatus: "not-performed"
  };
  const serialized = fitTraceOutputBudget(pack, maxOutputBytes, (candidate) => {
    retainReferencedToolCatalogs(candidate, allOfferedToolCatalogs);
  });
  const outputPath = writeTraceOutputExclusive(options.output, serialized);
  return {
    status: "completed",
    schemaVersion: RETAINED_TRACE_PACK_VERSION,
    outputPath,
    outputBytes: Buffer.byteLength(serialized),
    eventsReturned: pack.events.length,
    eventsAvailable: summary.eventCount,
    contentPolicy: "metadata-only",
    observerPackRetained: false,
    sourcePathStoredInPack: false,
    interpretationStatus: "not-performed"
  };
}
