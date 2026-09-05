import {
  activitySummaryRows,
  dailyActivityRows,
  deploymentRoutingEvents,
  deploymentToolRows,
  directRuntimeHealth,
  latestAgentHostDeployment,
  latestContextSurfaceRows,
  observedSemanticToolNames,
  providerHealth,
  semanticExecutionReportRows,
  traceAdapterHealth,
  traceIdentitySummaryRows,
  traceModelStepSummaryRows,
  traceToolEventSummaryRows,
  traceToolOfferRows,
  traceTurnSummaryRows,
  toolReportRows,
  toolSequenceEvents,
  toolUsageAssociationRows,
  usageReportRows
} from "./db-read.mjs";
import { negotiatedTraceAdapters } from "./trace-adapters.mjs";

export const REPORT_SCHEMA_VERSION = "openadam.agent-tool-observer.report.v0.8";
const ROUTING_EVENT_LIMIT = 50_000;
const ROUTING_OBSERVATION_LIMIT = 100;
const DAILY_ACTIVITY_LIMIT = 400;
const SESSION_START_BASIS = Object.freeze({
  codex: "codex-session-meta-timestamp",
  claude: "earliest-observed-claude-session-record-timestamp",
  zcode: "zcode-session-time-created-when-source-schema-exposes-it"
});

export function isCurrentReport(value) {
  return value?.schemaVersion === REPORT_SCHEMA_VERSION
    && Array.isArray(value.tools)
    && Array.isArray(value.portfolio?.highObservedErrorRates)
    && Array.isArray(value.portfolio?.repeatedUnmappedMcpUse)
    && Array.isArray(value.portfolio?.repeatedToolSequences)
    && !("fixCandidates" in value.portfolio)
    && !("capabilityCandidates" in value.portfolio)
    && !("procedureCandidates" in value.portfolio)
    && !("weakenRoutingCandidates" in value.portfolio)
    && !("retireCandidates" in value.portfolio)
    && value.freshSessionCorrelation?.adoptionStatus === "not-assessed"
    && Array.isArray(value.activity?.providers)
    && Array.isArray(value.activity?.daily)
    && Array.isArray(value.tracePlane?.adapters)
    && Array.isArray(value.tracePlane?.providers)
    && Array.isArray(value.tracePlane?.toolOffers)
    && value.tracePlane?.interpretationStatus === "not-performed"
    && value.observationCoverage?.skillUse?.status === "unavailable"
    && value.observationCoverage?.resultAdoption?.status === "not-observed"
    && value.observationCoverage?.nonUseReason?.status === "not-observed"
    && value.cost?.monetary?.status === "unavailable"
    && value.tools.every((tool) => tool?.correctnessStatus === "unknown"
      && tool?.opportunityStatus === "unknown"
      && !(("correctness" + "Evidence") in tool)
      && !(("opportunity" + "Evidence") in tool));
}

function numeric(value) {
  return value === null || value === undefined ? null : Number(value);
}

function dayOrdinal(value) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 86_400_000) : null;
}

function observedDayStreak(dates, today) {
  const ordinals = [...new Set(dates.map(dayOrdinal).filter(Number.isFinite))].sort((left, right) => left - right);
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const value of ordinals) {
    run = previous !== null && value === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = value;
  }
  const todayOrdinal = dayOrdinal(today);
  let current = 0;
  if (ordinals.at(-1) === todayOrdinal) {
    current = 1;
    for (let index = ordinals.length - 2; index >= 0 && ordinals[index] === ordinals[index + 1] - 1; index -= 1) current += 1;
  }
  return { current, longest };
}

function signalFor(row) {
  const measured = Number(row.measured);
  const errors = Number(row.errors);
  const calls = Number(row.calls);
  if (measured >= 5 && errors / measured >= 0.2) return "high-observed-error-rate";
  if (calls >= 5) return "observed-use";
  return "insufficient-data";
}

function semanticKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function operationKey(value) {
  const text = String(value);
  if (text.startsWith("mcp__")) return semanticKey(text.split("__").at(-1));
  return semanticKey(text);
}

function toolMatchesBinding(toolName, target) {
  return semanticKey(toolName) === semanticKey(target)
    || operationKey(toolName) === operationKey(target);
}

function hasSemanticTarget(toolName, targets) {
  return targets.some((target) => toolMatchesBinding(toolName, target));
}

function deploymentFromRow(row) {
  if (!row) return null;
  return {
    deploymentId: row.deployment_id,
    observedAtMs: Number(row.observed_at_ms),
    activatedAtMs: Number(row.activated_at_ms),
    channel: row.channel,
    releaseId: row.release_id,
    suiteVersion: row.suite_version,
    profile: row.profile,
    components: JSON.parse(row.components_json),
    context: row.context_source_id === null ? null : {
      sourceId: row.context_source_id,
      sourceRevision: row.context_source_revision,
      catalogSha256: row.context_catalog_sha256,
      catalogBytes: numeric(row.context_catalog_bytes),
      toolCount: numeric(row.context_tool_count)
    },
    observationBasis: "agent-host-deployment-observation"
  };
}

function deploymentBinding(toolName, deployment) {
  if (!deployment) return null;
  for (const component of deployment.components) {
    const matchedToolName = component.toolNames.find((candidate) => toolMatchesBinding(toolName, candidate));
    if (matchedToolName) return { component, matchedToolName };
  }
  return null;
}

function repeatedToolSequences(rows) {
  const turns = new Map();
  for (const row of rows) {
    const key = `${row.provider}\0${row.session_hash}\0${row.turn_hash}`;
    if (!turns.has(key)) {
      turns.set(key, { provider: row.provider, session: row.session_hash, tools: [] });
    }
    const tools = turns.get(key).tools;
    if (tools.at(-1) !== row.tool_name) tools.push(row.tool_name);
  }
  const sequences = new Map();
  for (const turn of turns.values()) {
    if (turn.tools.length < 2 || turn.tools.length > 8) continue;
    const key = `${turn.provider}\0${turn.tools.join("\0")}`;
    if (!sequences.has(key)) {
      sequences.set(key, { provider: turn.provider, tools: turn.tools, turns: 0, sessions: new Set() });
    }
    const candidate = sequences.get(key);
    candidate.turns += 1;
    candidate.sessions.add(turn.session);
  }
  return [...sequences.values()]
    .filter((candidate) => candidate.turns >= 3 && candidate.sessions.size >= 2)
    .map((candidate) => ({
      provider: candidate.provider,
      sequence: candidate.tools,
      observedTurns: candidate.turns,
      observedSessions: candidate.sessions.size,
      signal: "repeated-tool-sequence",
      correctnessStatus: "unknown",
      interpretationStatus: "not-performed"
    }))
    .sort((left, right) => right.observedTurns - left.observedTurns
      || left.sequence.join("\0").localeCompare(right.sequence.join("\0")))
    .slice(0, 25);
}

function deploymentRoutingAnalysis(rows, deployment) {
  if (!deployment) {
    return {
      observations: [],
      summary: {
        observationRecordsReturned: 0,
        observationRecordLimit: ROUTING_OBSERVATION_LIMIT,
        observationRecordsTruncated: false,
        matchingTurnsInScannedEvents: 0,
        sourceEventsScanned: 0,
        sourceEventLimit: ROUTING_EVENT_LIMIT,
        sourceEventsTruncated: false
      }
    };
  }
  const sourceEventsTruncated = rows.length > ROUTING_EVENT_LIMIT;
  const boundedRows = rows.slice(0, ROUTING_EVENT_LIMIT);
  const turns = new Map();
  for (const row of boundedRows) {
    const key = `${row.provider}\0${row.session_hash}\0${row.turn_hash}`;
    if (!turns.has(key)) {
      turns.set(key, {
        provider: row.provider,
        sessionHash: row.session_hash,
        turnHash: row.turn_hash,
        events: []
      });
    }
    turns.get(key).events.push(row);
  }
  const matchingTurns = [...turns.values()].flatMap((turn) => {
    const firstReleaseIndex = turn.events.findIndex((event) => deploymentBinding(event.tool_name, deployment));
    if (firstReleaseIndex < 0) return [];
    const preceding = turn.events.slice(0, firstReleaseIndex);
    const releaseEvents = turn.events.filter((event) => deploymentBinding(event.tool_name, deployment));
    const recoveryObserved = releaseEvents.some((event, index) => event.status === "error"
      && releaseEvents.slice(index + 1).some((later) => later.tool_name === event.tool_name && later.status === "completed"));
    const counts = new Map();
    for (const event of releaseEvents) counts.set(event.tool_name, (counts.get(event.tool_name) ?? 0) + 1);
    return [{
      provider: turn.provider,
      sessionHash: turn.sessionHash,
      turnHash: turn.turnHash,
      firstObservedTool: turn.events[0].tool_name,
      firstCurrentReleaseTool: turn.events[firstReleaseIndex].tool_name,
      currentReleaseToolFirst: firstReleaseIndex === 0,
      precedingToolCalls: preceding.length,
      precedingShellOrOrchestrationCalls: preceding.filter((event) => ["native-shell", "orchestration"].includes(event.route_class)).length,
      currentReleaseCalls: releaseEvents.length,
      currentReleaseErrors: releaseEvents.filter((event) => event.status === "error").length,
      runtimeRetries: releaseEvents.reduce((sum, event) => sum + Number(event.retry_count ?? 0), 0),
      repeatedCurrentReleaseCalls: [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      recoveryObserved,
      taskQualityStatus: "unknown",
      opportunityStatus: "unknown",
      observationBasis: "fresh-session-tool-order-metadata"
    }];
  });
  return {
    observations: matchingTurns.slice(0, ROUTING_OBSERVATION_LIMIT),
    summary: {
      observationRecordsReturned: Math.min(matchingTurns.length, ROUTING_OBSERVATION_LIMIT),
      observationRecordLimit: ROUTING_OBSERVATION_LIMIT,
      observationRecordsTruncated: sourceEventsTruncated || matchingTurns.length > ROUTING_OBSERVATION_LIMIT,
      matchingTurnsInScannedEvents: matchingTurns.length,
      sourceEventsScanned: boundedRows.length,
      sourceEventLimit: ROUTING_EVENT_LIMIT,
      sourceEventsTruncated
    }
  };
}

function sessionCoverageStatus(calls, unknownSessionStartCalls) {
  if (calls === 0) return "no-current-release-tool-calls-observed";
  if (unknownSessionStartCalls === 0) return "complete-for-observed-calls";
  if (unknownSessionStartCalls === calls) return "unavailable-for-observed-calls";
  return "partial-for-observed-calls";
}

function freshSessionCorrelation(deploymentRows, deployment, routingSummary) {
  const providers = new Map(Object.entries(SESSION_START_BASIS).map(([provider, sessionStartBasis]) => [provider, {
    provider,
    sessionStartBasis,
    currentReleaseToolCallsSinceActivation: 0,
    callsWithKnownSessionStart: 0,
    callsWithUnknownSessionStart: 0,
    freshSessionCallsSinceActivation: 0,
    preActivationSessionCallsSinceActivation: 0
  }]));
  if (deployment) {
    for (const row of deploymentRows) {
      if (!deploymentBinding(row.tool_name, deployment)) continue;
      const provider = providers.get(row.provider);
      if (!provider) continue;
      const calls = Number(row.calls ?? 0);
      const fresh = Number(row.fresh_session_calls ?? 0);
      const preActivation = Number(row.pre_activation_session_calls ?? 0);
      const unknown = Number(row.unknown_session_start_calls ?? 0);
      provider.currentReleaseToolCallsSinceActivation += calls;
      provider.callsWithKnownSessionStart += fresh + preActivation;
      provider.callsWithUnknownSessionStart += unknown;
      provider.freshSessionCallsSinceActivation += fresh;
      provider.preActivationSessionCallsSinceActivation += preActivation;
    }
  }
  return {
    scope: deployment ? "declared-current-agent-host-tool-bindings-since-release-activation" : "no-current-agent-host-deployment",
    providers: [...providers.values()].map((provider) => ({
      ...provider,
      coverageStatus: sessionCoverageStatus(provider.currentReleaseToolCallsSinceActivation, provider.callsWithUnknownSessionStart)
    })),
    routing: routingSummary,
    adoptionStatus: "not-assessed",
    taskQualityStatus: "unknown",
    opportunityStatus: "unknown",
    observationBasis: "provider-native-or-provider-record-session-start-metadata"
  };
}

export function buildReport(database, options = {}, nowMs = Date.now()) {
  const days = options.days ?? 30;
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  const currentDeployment = deploymentFromRow(latestAgentHostDeployment(database));
  const deploymentRows = currentDeployment ? deploymentToolRows(database, currentDeployment.activatedAtMs) : [];
  const deploymentCalls = new Map(
    deploymentRows
      .map((row) => [`${row.provider}\0${row.tool_name}`, row])
  );
  const usageAssociations = new Map(
    toolUsageAssociationRows(database, cutoffMs, options.openAdamOnly === true)
      .map((row) => [`${row.provider}\0${row.tool_name}`, row])
  );
  const tools = toolReportRows(database, cutoffMs, options.openAdamOnly === true).map((row) => {
    const measured = Number(row.measured);
    const errors = Number(row.errors);
    const associated = usageAssociations.get(`${row.provider}\0${row.tool_name}`);
    const binding = deploymentBinding(row.tool_name, currentDeployment);
    const deploymentCall = deploymentCalls.get(`${row.provider}\0${row.tool_name}`);
    const freshSessionCalls = Number(deploymentCall?.fresh_session_calls ?? 0);
    const preActivationSessionCalls = Number(deploymentCall?.pre_activation_session_calls ?? 0);
    const unknownSessionStartCalls = Number(deploymentCall?.unknown_session_start_calls ?? 0);
    const callsSinceActivation = Number(deploymentCall?.calls ?? 0);
    return {
      provider: row.provider,
      toolName: row.tool_name,
      toolNamespace: row.tool_namespace,
      routeClass: row.route_class,
      openAdam: row.is_openadam === 1,
      calls: Number(row.calls),
      runtime: {
        measured,
        completed: Number(row.completed),
        errors,
        cancelled: Number(row.cancelled),
        errorRate: measured > 0 ? errors / measured : null,
        averageDurationMs: numeric(row.average_duration_ms),
        retries: numeric(row.retries)
      },
      derivedCalls: Number(row.derived),
      payload: {
        requestBytes: numeric(row.request_bytes),
        responseBytes: numeric(row.response_bytes),
        requestBytesMeasuredCalls: Number(row.request_bytes_measured),
        responseBytesMeasuredCalls: Number(row.response_bytes_measured),
        measurementBasis: "serialized-tool-payload-size-without-content-retention"
      },
      turnAssociatedUsage: associated ? {
        associatedTurns: Number(associated.associated_turns),
        usageRecords: Number(associated.usage_records),
        inputTokens: numeric(associated.input_tokens),
        cachedInputTokens: numeric(associated.cached_input_tokens),
        outputTokens: numeric(associated.output_tokens),
        reasoningTokens: numeric(associated.reasoning_tokens),
        totalTokens: numeric(associated.total_tokens),
        allocation: "shared-turn-not-attributed-to-one-tool"
      } : {
        associatedTurns: 0,
        usageRecords: 0,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        allocation: row.provider === "codex"
          ? "unavailable-session-cumulative-provider-usage"
          : "no-matching-turn-usage"
      },
      firstObservedAtMs: numeric(row.first_observed_at_ms),
      lastObservedAtMs: numeric(row.last_observed_at_ms),
      signal: signalFor(row),
      correctnessStatus: "unknown",
      opportunityStatus: "unknown",
      routingMode: "unknown",
      currentAgentHostDeployment: binding ? {
        status: freshSessionCalls > 0
          ? "fresh-session-observed"
          : callsSinceActivation === 0
            ? "declared-binding-only"
            : unknownSessionStartCalls === callsSinceActivation
              ? "session-start-unavailable"
              : "no-fresh-session-correlation",
        releaseId: currentDeployment.releaseId,
        suiteVersion: currentDeployment.suiteVersion,
        profile: currentDeployment.profile,
        componentId: binding.component.id,
        componentVersion: binding.component.version,
        declaredToolName: binding.matchedToolName,
        callsSinceActivation,
        freshSessionCallsSinceActivation: freshSessionCalls,
        preActivationSessionCallsSinceActivation: preActivationSessionCalls,
        unknownSessionStartCallsSinceActivation: unknownSessionStartCalls,
        ambiguousSessionCallsSinceActivation: preActivationSessionCalls + unknownSessionStartCalls,
        sessionStartBasis: SESSION_START_BASIS[row.provider] ?? "unavailable",
        sessionStartCoverageStatus: sessionCoverageStatus(callsSinceActivation, unknownSessionStartCalls),
        mappingBasis: "declared-agent-host-tool-binding-and-provider-session-start-metadata"
      } : {
        status: row.is_openadam === 1 ? "outside-current-agent-host-deployment" : "not-applicable"
      }
    };
  });
  const rawDaily = dailyActivityRows(database, cutoffMs);
  const daily = rawDaily.slice(-DAILY_ACTIVITY_LIMIT).map((row) => ({
    provider: row.provider,
    utcDate: row.utc_date,
    toolCalls: Number(row.tool_calls),
    usageRecords: Number(row.usage_records),
    observedSessions: Number(row.observed_sessions),
    observedTurns: Number(row.observed_turns),
    inputTokens: numeric(row.input_tokens),
    cachedInputTokens: numeric(row.cached_input_tokens),
    outputTokens: numeric(row.output_tokens),
    reasoningTokens: numeric(row.reasoning_tokens),
    totalTokens: numeric(row.total_tokens)
  }));
  const dailyByProvider = new Map();
  for (const row of daily) {
    if (!dailyByProvider.has(row.provider)) dailyByProvider.set(row.provider, []);
    dailyByProvider.get(row.provider).push(row);
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const usage = usageReportRows(database, cutoffMs).map((row) => {
    const providerDays = dailyByProvider.get(row.provider) ?? [];
    const tokenDays = providerDays.filter((item) => item.totalTokens !== null);
    const peak = tokenDays.reduce((best, item) => best === null || item.totalTokens > best.totalTokens ? item : best, null);
    return {
    provider: row.provider,
    records: Number(row.records),
    inputTokens: numeric(row.input_tokens),
    cachedInputTokens: numeric(row.cached_input_tokens),
    outputTokens: numeric(row.output_tokens),
    reasoningTokens: numeric(row.reasoning_tokens),
    totalTokens: numeric(row.total_tokens),
    averageDurationMs: numeric(row.average_duration_ms),
    semantics: row.provider === "codex"
      ? "latest-cumulative-session-rollup-per-observed-session"
      : row.provider === "claude"
        ? "message-usage-total-excludes-separately-reported-cache-read"
        : "provider-reported-model-usage-record",
    peakObservedDailyTokens: peak?.totalTokens ?? null,
    peakObservedDailyDate: peak?.utcDate ?? null,
    dailyTokenSemantics: row.provider === "codex"
      ? "latest-cumulative-session-rollups-grouped-by-their-observed-utc-day-not-incremental-daily-consumption"
      : "provider-reported-usage-records-grouped-by-observed-utc-day"
  };
  });
  const activity = {
    providers: activitySummaryRows(database, cutoffMs).map((row) => {
      const streak = observedDayStreak((dailyByProvider.get(row.provider) ?? []).map((item) => item.utcDate), today);
      return {
      provider: row.provider,
      observedSessions: Number(row.observed_sessions),
      observedTurns: Number(row.observed_turns),
      observedActiveDays: Number(row.observed_active_days),
      firstObservedAtMs: numeric(row.first_observed_at_ms),
      lastObservedAtMs: numeric(row.last_observed_at_ms),
      longestObservedSessionSpanMs: numeric(row.longest_observed_session_span_ms),
      sessionDurationSemantics: "span-between-first-and-last-observed-metadata-events-not-chat-duration",
      currentObservedDayStreak: streak.current,
      longestObservedDayStreak: streak.longest
    };
    }),
    daily,
    dailyRowsAvailable: rawDaily.length,
    dailyRowsReturned: daily.length,
    dailyRowLimit: DAILY_ACTIVITY_LIMIT,
    dailyRowsTruncated: rawDaily.length > DAILY_ACTIVITY_LIMIT,
    sessionSemantics: "provider-scoped-hashed-session-identifiers",
    turnSemantics: "provider-scoped-hashed-turn-identifiers-when-exposed",
    activeDaySemantics: "utc-days-with-observed-tool-or-usage-metadata",
    dayStreakSemantics: "consecutive-utc-days-with-observed-tool-or-usage-metadata-current-streak-requires-observation-today"
  };
  const targets = observedSemanticToolNames(database);
  const repeatedUnmappedMcpUse = tools
    .filter((tool) => tool.routeClass === "mcp" && tool.calls >= 5
      && !hasSemanticTarget(tool.toolName, targets))
    .map((tool) => ({
      provider: tool.provider,
      toolName: tool.toolName,
      calls: tool.calls,
      signal: "repeated-unmapped-mcp-use",
      basis: "repeated-unmapped-mcp-use",
      correctnessStatus: "unknown",
      interpretationStatus: "not-performed"
    }));
  const repeatedSequences = repeatedToolSequences(
    toolSequenceEvents(database, cutoffMs, options.openAdamOnly === true)
  );
  const semanticExecutions = semanticExecutionReportRows(database, cutoffMs).map((row) => ({
    target: row.target_kind === "capability" ? {
      kind: "capability",
      capabilityId: row.semantic_id,
      capabilityVersion: row.semantic_version,
      operationId: row.operation_id
    } : row.target_kind === "procedure" ? {
      kind: "procedure",
      procedureId: row.semantic_id,
      procedureVersion: row.semantic_version
    } : row.target_kind === "mcp-operation" ? {
      kind: "mcp-operation",
      toolName: row.tool_name,
      operationId: row.operation_id
    } : {
      kind: "mcp-tool",
      toolName: row.tool_name
    },
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    transport: row.transport,
    lifecycle: row.lifecycle,
    executions: Number(row.executions),
    runtime: {
      completed: Number(row.completed),
      providerErrors: Number(row.provider_errors),
      hostErrors: Number(row.host_errors),
      averageDurationMs: numeric(row.average_duration_ms),
      averageQueueMs: numeric(row.average_queue_ms),
      averageProviderRoundTripMs: numeric(row.average_provider_round_trip_ms)
    },
    payload: {
      requestBytes: numeric(row.request_bytes),
      responseBytes: numeric(row.response_bytes)
    },
    executionCost: {
      modelCalls: 0,
      tokenUsage: null,
      monetaryCost: null,
      externalCostStatus: "not_observed"
    },
    firstObservedAtMs: numeric(row.first_observed_at_ms),
    lastObservedAtMs: numeric(row.last_observed_at_ms),
    observationBasis: "direct-runtime-metadata-event",
    correctnessStatus: "unknown"
  }));
  const directHealth = directRuntimeHealth(database);
  const contextSurfaces = latestContextSurfaceRows(database).map((row) => ({
    source: { id: row.source_id, revision: row.source_revision },
    importedAtMs: Number(row.imported_at_ms),
    snapshot: { sha256: row.snapshot_sha256, canonicalUtf8Bytes: Number(row.snapshot_bytes) },
    catalog: {
      sha256: row.catalog_sha256,
      canonicalUtf8Bytes: Number(row.catalog_bytes),
      largestToolUtf8Bytes: Number(row.largest_tool_bytes)
    },
    counts: {
      tools: Number(row.tool_count),
      schemas: Number(row.schema_count),
      describedTools: Number(row.described_tool_count),
      duplicateSchemas: Number(row.duplicate_schema_count),
      hardNameCollisions: Number(row.hard_name_collision_count)
    },
    tokenMeasurements: JSON.parse(row.token_measurements_json),
    measurementBasis: "explicit-context-surface-analysis-import",
    currentInstalledBindingStatus: !currentDeployment?.context
      ? "not_assessed"
      : currentDeployment.context.sourceId === row.source_id
        && currentDeployment.context.sourceRevision === row.source_revision
        && currentDeployment.context.catalogSha256 === row.catalog_sha256
        ? "matched-current-agent-host-deployment"
        : "not-current-agent-host-deployment"
  }));
  const routingAnalysis = currentDeployment
    ? deploymentRoutingAnalysis(deploymentRoutingEvents(database, currentDeployment.activatedAtMs), currentDeployment)
    : deploymentRoutingAnalysis([], null);
  const routingObservations = routingAnalysis.observations;
  const deploymentFreshSessionCorrelation = freshSessionCorrelation(deploymentRows, currentDeployment, routingAnalysis.summary);
  const traceKey = (row) => [row.provider, row.adapter_id, row.adapter_version, row.provider_version ?? "", row.source_format].join("\0");
  const traceModelSummaries = new Map(
    traceModelStepSummaryRows(database, cutoffMs).map((row) => [traceKey(row), row])
  );
  const traceToolSummaries = new Map(
    traceToolEventSummaryRows(database, cutoffMs)
      .map((row) => [traceKey(row), row])
  );
  const traceTurnSummaries = new Map(
    traceTurnSummaryRows(database, cutoffMs)
      .map((row) => [traceKey(row), row])
  );
  const traceProviders = traceIdentitySummaryRows(database, cutoffMs).map((row) => {
    const key = traceKey(row);
    const model = traceModelSummaries.get(key);
    const tool = traceToolSummaries.get(key);
    const turn = traceTurnSummaries.get(key);
    return {
      provider: row.provider,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      providerVersion: row.provider_version,
      sourceFormat: row.source_format,
      modelSteps: Number(model?.model_steps ?? 0),
      observedSessions: Number(row.observed_sessions),
      observedTurns: Number(row.observed_turns),
      modelErrors: Number(model?.model_errors ?? 0),
      modelCancellations: Number(model?.model_cancellations ?? 0),
      offeredToolObservations: numeric(model?.offered_tool_observations),
      emittedToolCalls: numeric(model?.emitted_tool_calls),
      traceToolCalls: Number(tool?.tool_calls ?? 0),
      traceToolResults: Number(tool?.tool_results ?? 0),
      traceToolResultErrors: Number(tool?.tool_result_errors ?? 0),
      turnEnds: Number(turn?.turn_ends ?? 0),
      completedTurns: Number(turn?.completed_turns ?? 0),
      errorTurns: Number(turn?.error_turns ?? 0),
      cancelledTurns: Number(turn?.cancelled_turns ?? 0),
      requestMessages: numeric(model?.request_messages),
      payload: {
        requestBytes: numeric(model?.request_bytes),
        responseBytes: numeric(model?.response_bytes),
        contentStored: false
      },
      usage: {
        inputTokens: numeric(model?.input_tokens),
        cachedInputTokens: numeric(model?.cached_input_tokens),
        outputTokens: numeric(model?.output_tokens),
        reasoningTokens: numeric(model?.reasoning_tokens),
        totalTokens: numeric(model?.total_tokens),
        providerReported: true
      },
      stepsWithSelfReportedRationale: Number(model?.steps_with_self_reported_rationale ?? 0),
      averageDurationMs: numeric(model?.average_duration_ms),
      firstObservedAtMs: numeric(row.first_observed_at_ms),
      lastObservedAtMs: numeric(row.last_observed_at_ms),
      correctnessStatus: "unknown",
      adoptionStatus: "not-observed",
      nonUseReasonStatus: "not-observed"
    };
  });
  const tracePlane = {
    adapters: negotiatedTraceAdapters(traceAdapterHealth(database), providerHealth(database)),
    providers: traceProviders,
    toolOffers: traceToolOfferRows(database, cutoffMs).map((row) => ({
      provider: row.provider,
      adapterId: row.adapter_id,
      toolName: row.tool_name,
      toolNamespace: row.tool_namespace,
      routeClass: row.route_class,
      openAdam: row.is_openadam === 1,
      observedRequestCatalogs: Number(row.observed_request_catalogs),
      firstObservedAtMs: numeric(row.first_observed_at_ms),
      lastObservedAtMs: numeric(row.last_observed_at_ms),
      semantics: "named-tool-present-in-recorded-request-catalog-not-skill-activation-or-use"
    })),
    passiveStorage: "metadata-only",
    explicitAnalysisPack: {
      status: "user-selected-only",
      defaultContentPolicy: "metadata-only",
      sensitiveContentRequiresExplicitConfirmation: true,
      retainedSessionContentPolicy: "metadata-only",
      retainedSessionSelectedContentAvailable: false,
      observerRetainedMetadataSourceAvailable: true,
      observerDatabaseRetention: false
    },
    interpretationStatus: "not-performed",
    correctnessStatus: "unknown",
    adoptionStatus: "not-observed",
    nonUseReasonStatus: "not-observed"
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtMs: nowMs,
    windowDays: days,
    filter: options.openAdamOnly ? "openadam" : "all-tools",
    providers: providerHealth(database).map((row) => ({
      provider: row.provider,
      status: row.status,
      errorCode: row.error_code,
      scannedAtMs: Number(row.scanned_at_ms)
    })),
    currentAgentHostDeployment: currentDeployment,
    freshSessionCorrelation: deploymentFreshSessionCorrelation,
    routingObservations,
    tools,
    usage,
    activity,
    tracePlane,
    observationCoverage: {
      toolInvocation: {
        status: tools.length > 0 ? "observed" : "no-observations",
        basis: "provider-tool-call-metadata"
      },
      runtimeOutcome: {
        status: tools.some((tool) => tool.runtime.measured > 0) ? "partial" : "unavailable",
        basis: "provider-reported-completed-error-or-cancelled-state"
      },
      tokenUsage: {
        status: usage.length > 0 ? "partial" : "unavailable",
        basis: "provider-reported-usage-with-provider-specific-semantics"
      },
      toolOffer: {
        status: tracePlane.toolOffers.length > 0 ? "partial" : "unavailable",
        basis: "named-tools-in-recorded-model-request-catalogs",
        offeredIsNotSkillActivationOrUse: true
      },
      modelStep: {
        status: tracePlane.providers.length > 0 ? "partial" : "unavailable",
        basis: "adapter-versioned-shell-trace-metadata"
      },
      skillUse: {
        status: "unavailable",
        reason: "supported-provider-records-do-not-expose-authoritative-skill-activation-events",
        availableInventoryIsNotUse: true
      },
      semanticEffect: {
        status: "not-observed",
        reason: "passive-provider-records-do-not-establish-the-task-level-effect-of-a-tool-result"
      },
      resultAdoption: {
        status: "not-observed",
        reason: "a-later-agent-message-or-artifact-does-not-establish-that-the-tool-result-was-accepted"
      },
      nonUseReason: {
        status: "not-observed",
        reason: "absence-of-a-call-does-not-reveal-why-an-agent-did-not-use-a-tool",
        assessmentRoute: "explicit-agent-assessment-or-controlled-baseline-treatment-evaluation"
      }
    },
    cost: {
      dynamicPayloadBytes: {
        status: tools.some((tool) => tool.payload.requestBytesMeasuredCalls > 0
          || tool.payload.responseBytesMeasuredCalls > 0) ? "partial" : "unavailable",
        contentStored: false
      },
      tokenAssociation: {
        status: tools.some((tool) => tool.turnAssociatedUsage.usageRecords > 0) ? "partial" : "unavailable",
        allocation: "shared-turn-not-attributed-to-one-tool"
      },
      staticContext: {
        status: contextSurfaces.length > 0 ? "explicit-snapshots-imported" : "unavailable",
        installedCatalogAcquisition: currentDeployment?.context
          ? "agent-host-deployment-observation"
          : "outside-observer"
      },
      monetary: {
        status: "unavailable",
        reason: "model-and-pricing-identity-not-observed-at-tool-call-granularity"
      }
    },
    semanticExecutions,
    directRuntime: directHealth ? {
      status: directHealth.status,
      errorCode: directHealth.error_code,
      scannedAtMs: Number(directHealth.scanned_at_ms),
      filesSeen: Number(directHealth.files_seen),
      eventsWritten: Number(directHealth.events_written)
    } : {
      status: "not-collected",
      errorCode: null,
      scannedAtMs: null,
      filesSeen: 0,
      eventsWritten: 0
    },
    contextSurfaces,
    portfolio: {
      highObservedErrorRates: tools.filter((tool) => tool.signal === "high-observed-error-rate").map((tool) => ({
        provider: tool.provider,
        toolName: tool.toolName,
        measuredCalls: tool.runtime.measured,
        errors: tool.runtime.errors,
        errorRate: tool.runtime.errorRate,
        basis: "minimum-measured-calls-and-observed-runtime-error-rate",
        interpretationStatus: "not-performed"
      })),
      repeatedUnmappedMcpUse,
      repeatedToolSequences: repeatedSequences,
      claimBoundary: "Direct Runtime events record metadata about actual direct execution; imported Context Surface analyses measure explicit snapshots. Agent Host deployment observations declare one active immutable release. A matching tool name from a provider record whose observed session start is at or after activation is only a current-release correlation candidate, not causal attribution or proof of the catalog loaded by that host; pre-activation and unknown-start sessions remain separate. Fresh-session routing records are bounded metadata records, and their returned count is not a total when either bound is reached. Repeated use, repeated sequences, and high observed error rates are neutral observations. None establishes correctness, adoption opportunity, natural routing, semantic layer fit, repair need, redundancy, retirement, exclusive call attribution, task quality, authorization, or an action."
    },
    privacy: {
      rawContentStored: false,
      sourcePathsStored: false,
      networkUsed: false,
      modelCalls: 0
    }
  };
}

function percent(value) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function renderReport(report) {
  const lines = [
    `Agent Tool Observer — ${report.windowDays} day window`,
    `Providers: ${report.providers.map((item) => `${item.provider}=${item.status}`).join(", ") || "none"}`,
    "",
    "Calls  Provider  Tool                                      Runtime errors  Signal",
    "-----  --------  ----------------------------------------  --------------  -----------------"
  ];
  for (const tool of report.tools.slice(0, 50)) {
    const name = tool.toolName.length > 40 ? `${tool.toolName.slice(0, 37)}...` : tool.toolName;
    lines.push(
      `${String(tool.calls).padStart(5)}  ${tool.provider.padEnd(8)}  ${name.padEnd(40)}  ${percent(tool.runtime.errorRate).padStart(14)}  ${tool.signal}`
    );
  }
  if (report.tools.length === 0) lines.push("    0  —         No observations in this window");
  lines.push(
    "",
    `High observed error rates: ${report.portfolio.highObservedErrorRates.length}`,
    `Direct semantic execution groups: ${(report.semanticExecutions ?? []).length}; source=${report.directRuntime?.status ?? "not-collected"}`,
    `Static context snapshots: ${(report.contextSurfaces ?? []).length}; monetary cost=${report.cost?.monetary?.status ?? "unavailable"}`,
    `Current Agent Host deployment: ${report.currentAgentHostDeployment?.releaseId ?? "not observed"}`,
    `Repeated patterns: ${(report.portfolio.repeatedUnmappedMcpUse ?? []).length} unmapped MCP tools, ${(report.portfolio.repeatedToolSequences ?? []).length} tool sequences`,
    "Interpretation/action: not performed; routing, repair, standardization, and retirement remain external judgments.",
    "Privacy: metadata only, no source paths or raw content, no network, no model calls."
  );
  return `${lines.join("\n")}\n`;
}
