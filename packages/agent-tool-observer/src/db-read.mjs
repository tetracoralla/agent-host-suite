export function latestCollection(database) {
  return database.prepare(`
    SELECT * FROM collection_run ORDER BY started_at_ms DESC LIMIT 1
  `).get() ?? null;
}

export function providerHealth(database) {
  return database.prepare(`
    SELECT * FROM provider_health ORDER BY provider
  `).all();
}

export function directRuntimeHealth(database) {
  return database.prepare(`
    SELECT * FROM direct_runtime_health WHERE source = 'direct-runtime'
  `).get() ?? null;
}

export function traceAdapterHealth(database) {
  return database.prepare(`
    SELECT * FROM trace_adapter_health ORDER BY provider, adapter_id
  `).all();
}

export function databaseStats(database) {
  return {
    toolEvents: Number(database.prepare("SELECT count(*) AS value FROM tool_event").get().value),
    usageEvents: Number(database.prepare("SELECT count(*) AS value FROM usage_event").get().value),
    traceModelSteps: Number(database.prepare("SELECT count(*) AS value FROM trace_model_step").get().value),
    traceToolOffers: Number(database.prepare("SELECT count(*) AS value FROM trace_tool_offer").get().value),
    traceToolEvents: Number(database.prepare("SELECT count(*) AS value FROM trace_tool_event").get().value),
    traceTurnEvents: Number(database.prepare("SELECT count(*) AS value FROM trace_turn_event").get().value),
    procedureEvents: Number(database.prepare("SELECT count(*) AS value FROM procedure_event").get().value),
    capabilityEvents: Number(database.prepare("SELECT count(*) AS value FROM capability_event").get().value),
    semanticExecutionEvents: Number(database.prepare("SELECT count(*) AS value FROM semantic_execution_event").get().value),
    contextSurfaceMeasurements: Number(database.prepare("SELECT count(*) AS value FROM context_surface_measurement").get().value),
    agentHostDeploymentObservations: Number(database.prepare("SELECT count(*) AS value FROM agent_host_deployment_observation").get().value),
    directRuntimeSources: Number(database.prepare("SELECT count(*) AS value FROM direct_runtime_cursor").get().value),
    sources: Number(database.prepare("SELECT count(*) AS value FROM source_cursor").get().value),
    traceSources: Number(database.prepare("SELECT count(*) AS value FROM trace_cursor").get().value)
  };
}

export function traceModelStepSummaryRows(database, cutoffMs) {
  return database.prepare(`
    SELECT
      provider, adapter_id, adapter_version, provider_version, source_format,
      count(*) AS model_steps,
      count(DISTINCT session_hash) AS observed_sessions,
      count(DISTINCT turn_hash) AS observed_turns,
      sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS model_errors,
      sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS model_cancellations,
      sum(offered_tool_count) AS offered_tool_observations,
      sum(emitted_tool_call_count) AS emitted_tool_calls,
      sum(request_message_count) AS request_messages,
      sum(request_bytes) AS request_bytes,
      sum(response_bytes) AS response_bytes,
      sum(input_tokens) AS input_tokens,
      sum(cached_input_tokens) AS cached_input_tokens,
      sum(output_tokens) AS output_tokens,
      sum(reasoning_tokens) AS reasoning_tokens,
      sum(total_tokens) AS total_tokens,
      sum(CASE WHEN rationale_present = 1 THEN 1 ELSE 0 END) AS steps_with_self_reported_rationale,
      avg(duration_ms) AS average_duration_ms,
      min(occurred_at_ms) AS first_observed_at_ms,
      max(coalesce(completed_at_ms, occurred_at_ms)) AS last_observed_at_ms
    FROM trace_model_step
    WHERE occurred_at_ms >= ?
    GROUP BY provider, adapter_id, adapter_version, provider_version, source_format
    ORDER BY provider, adapter_id
  `).all(cutoffMs);
}

export function traceToolEventSummaryRows(database, cutoffMs) {
  return database.prepare(`
    SELECT
      event.provider, event.adapter_id, event.adapter_version,
      event.provider_version, event.source_format,
      sum(CASE WHEN event.kind = 'tool-call' THEN 1 ELSE 0 END) AS tool_calls,
      sum(CASE WHEN event.kind = 'tool-result' THEN 1 ELSE 0 END) AS tool_results,
      sum(CASE WHEN event.kind = 'tool-result' AND event.status = 'error' THEN 1 ELSE 0 END) AS tool_result_errors
    FROM trace_tool_event AS event
    LEFT JOIN trace_model_step AS step
      ON step.provider = event.provider
      AND step.adapter_id = event.adapter_id
      AND step.request_hash = event.request_hash
    WHERE coalesce(event.occurred_at_ms, step.occurred_at_ms, event.recorded_at_ms) >= ?
    GROUP BY event.provider, event.adapter_id, event.adapter_version,
      event.provider_version, event.source_format
    ORDER BY event.provider, event.adapter_id, event.provider_version
  `).all(cutoffMs);
}

export function traceToolOfferRows(database, cutoffMs, limit = 100) {
  return database.prepare(`
    SELECT
      step.provider, step.adapter_id, offer.tool_name, offer.tool_namespace,
      offer.route_class, offer.is_openadam,
      count(*) AS observed_request_catalogs,
      min(step.occurred_at_ms) AS first_observed_at_ms,
      max(step.occurred_at_ms) AS last_observed_at_ms
    FROM trace_tool_offer AS offer
    JOIN trace_model_step AS step ON step.event_id = offer.event_id
    WHERE step.occurred_at_ms >= ?
    GROUP BY step.provider, step.adapter_id, offer.tool_name,
      offer.tool_namespace, offer.route_class, offer.is_openadam
    ORDER BY observed_request_catalogs DESC, step.provider, offer.tool_name
    LIMIT ?
  `).all(cutoffMs, limit);
}

export function traceTurnSummaryRows(database, cutoffMs) {
  return database.prepare(`
    SELECT
      provider, adapter_id, adapter_version, provider_version, source_format,
      count(*) AS turn_ends,
      sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_turns,
      sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_turns,
      sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_turns
    FROM trace_turn_event
    WHERE coalesce(completed_at_ms, occurred_at_ms, recorded_at_ms) >= ?
    GROUP BY provider, adapter_id, adapter_version, provider_version, source_format
    ORDER BY provider, adapter_id, provider_version
  `).all(cutoffMs);
}

export function traceIdentitySummaryRows(database, cutoffMs) {
  return database.prepare(`
    WITH trace_events AS (
      SELECT provider, adapter_id, adapter_version, provider_version,
        source_format, session_hash, turn_hash, occurred_at_ms,
        coalesce(completed_at_ms, occurred_at_ms, recorded_at_ms) AS last_observed_at_ms
      FROM trace_model_step
      WHERE coalesce(occurred_at_ms, recorded_at_ms) >= ?
      UNION ALL
      SELECT provider, adapter_id, adapter_version, provider_version,
        source_format, session_hash, turn_hash,
        coalesce(occurred_at_ms, recorded_at_ms),
        coalesce(completed_at_ms, occurred_at_ms, recorded_at_ms)
      FROM trace_tool_event
      WHERE coalesce(occurred_at_ms, recorded_at_ms) >= ?
      UNION ALL
      SELECT provider, adapter_id, adapter_version, provider_version,
        source_format, session_hash, turn_hash,
        coalesce(occurred_at_ms, recorded_at_ms),
        coalesce(completed_at_ms, occurred_at_ms, recorded_at_ms)
      FROM trace_turn_event
      WHERE coalesce(occurred_at_ms, recorded_at_ms) >= ?
    )
    SELECT provider, adapter_id, adapter_version, provider_version, source_format,
      count(DISTINCT session_hash) AS observed_sessions,
      count(DISTINCT turn_hash) AS observed_turns,
      min(occurred_at_ms) AS first_observed_at_ms,
      max(last_observed_at_ms) AS last_observed_at_ms
    FROM trace_events
    GROUP BY provider, adapter_id, adapter_version, provider_version, source_format
    ORDER BY provider, adapter_id, provider_version
  `).all(cutoffMs, cutoffMs, cutoffMs);
}

export function toolReportRows(database, cutoffMs, openAdamOnly = false) {
  return database.prepare(`
    SELECT
      provider,
      tool_name,
      tool_namespace,
      route_class,
      is_openadam,
      count(*) AS calls,
      sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      sum(CASE WHEN status IN ('completed', 'error', 'cancelled') THEN 1 ELSE 0 END) AS measured,
      sum(CASE WHEN derived = 1 THEN 1 ELSE 0 END) AS derived,
      avg(duration_ms) AS average_duration_ms,
      sum(retry_count) AS retries,
      sum(request_bytes) AS request_bytes,
      sum(response_bytes) AS response_bytes,
      sum(CASE WHEN request_bytes IS NOT NULL THEN 1 ELSE 0 END) AS request_bytes_measured,
      sum(CASE WHEN response_bytes IS NOT NULL THEN 1 ELSE 0 END) AS response_bytes_measured,
      min(occurred_at_ms) AS first_observed_at_ms,
      max(occurred_at_ms) AS last_observed_at_ms
    FROM tool_event
    WHERE occurred_at_ms >= ? AND (? = 0 OR is_openadam = 1)
    GROUP BY provider, tool_name, tool_namespace, route_class, is_openadam
    ORDER BY calls DESC, tool_name ASC
  `).all(cutoffMs, openAdamOnly ? 1 : 0);
}

export function toolUsageAssociationRows(database, cutoffMs, openAdamOnly = false) {
  return database.prepare(`
    WITH tool_turns AS (
      SELECT DISTINCT provider, tool_name, turn_hash
      FROM tool_event
      WHERE occurred_at_ms >= ?
        AND provider IN ('claude', 'zcode')
        AND turn_hash IS NOT NULL
        AND (? = 0 OR is_openadam = 1)
    )
    SELECT
      tool_turns.provider,
      tool_turns.tool_name,
      count(DISTINCT tool_turns.turn_hash) AS associated_turns,
      count(usage_event.event_id) AS usage_records,
      sum(usage_event.input_tokens) AS input_tokens,
      sum(usage_event.cached_input_tokens) AS cached_input_tokens,
      sum(usage_event.output_tokens) AS output_tokens,
      sum(usage_event.reasoning_tokens) AS reasoning_tokens,
      sum(usage_event.total_tokens) AS total_tokens
    FROM tool_turns
    JOIN usage_event
      ON usage_event.provider = tool_turns.provider
      AND usage_event.turn_hash = tool_turns.turn_hash
      AND usage_event.occurred_at_ms >= ?
    GROUP BY tool_turns.provider, tool_turns.tool_name
    ORDER BY tool_turns.provider, tool_turns.tool_name
  `).all(cutoffMs, openAdamOnly ? 1 : 0, cutoffMs);
}

export function usageReportRows(database, cutoffMs) {
  return database.prepare(`
    SELECT
      provider,
      count(*) AS records,
      sum(input_tokens) AS input_tokens,
      sum(cached_input_tokens) AS cached_input_tokens,
      sum(output_tokens) AS output_tokens,
      sum(reasoning_tokens) AS reasoning_tokens,
      sum(total_tokens) AS total_tokens,
      avg(duration_ms) AS average_duration_ms
    FROM usage_event
    WHERE occurred_at_ms >= ?
    GROUP BY provider
    ORDER BY provider
  `).all(cutoffMs);
}

export function activitySummaryRows(database, cutoffMs) {
  return database.prepare(`
    WITH activity AS (
      SELECT provider, session_hash, turn_hash,
        occurred_at_ms AS first_observed_at_ms,
        coalesce(completed_at_ms, occurred_at_ms) AS last_observed_at_ms
      FROM tool_event
      WHERE occurred_at_ms >= ?
      UNION ALL
      SELECT provider, session_hash, turn_hash,
        occurred_at_ms AS first_observed_at_ms,
        occurred_at_ms AS last_observed_at_ms
      FROM usage_event
      WHERE occurred_at_ms >= ?
    ), sessions AS (
      SELECT
        provider,
        session_hash,
        min(first_observed_at_ms) AS first_observed_at_ms,
        max(last_observed_at_ms) AS last_observed_at_ms
      FROM activity
      WHERE session_hash IS NOT NULL AND first_observed_at_ms IS NOT NULL
      GROUP BY provider, session_hash
    )
    SELECT
      activity.provider,
      count(DISTINCT activity.session_hash) AS observed_sessions,
      count(DISTINCT activity.turn_hash) AS observed_turns,
      count(DISTINCT strftime('%Y-%m-%d', activity.first_observed_at_ms / 1000, 'unixepoch')) AS observed_active_days,
      min(activity.first_observed_at_ms) AS first_observed_at_ms,
      max(activity.last_observed_at_ms) AS last_observed_at_ms,
      (SELECT max(last_observed_at_ms - first_observed_at_ms)
        FROM sessions
        WHERE sessions.provider = activity.provider) AS longest_observed_session_span_ms
    FROM activity
    GROUP BY activity.provider
    ORDER BY activity.provider
  `).all(cutoffMs, cutoffMs);
}

export function dailyActivityRows(database, cutoffMs) {
  return database.prepare(`
    WITH activity AS (
      SELECT provider, session_hash, turn_hash, occurred_at_ms,
        1 AS tool_calls, 0 AS usage_records,
        NULL AS input_tokens, NULL AS cached_input_tokens,
        NULL AS output_tokens, NULL AS reasoning_tokens, NULL AS total_tokens
      FROM tool_event
      WHERE occurred_at_ms >= ?
      UNION ALL
      SELECT provider, session_hash, turn_hash, occurred_at_ms,
        0 AS tool_calls, 1 AS usage_records,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens
      FROM usage_event
      WHERE occurred_at_ms >= ?
    )
    SELECT
      provider,
      strftime('%Y-%m-%d', occurred_at_ms / 1000, 'unixepoch') AS utc_date,
      sum(tool_calls) AS tool_calls,
      sum(usage_records) AS usage_records,
      count(DISTINCT session_hash) AS observed_sessions,
      count(DISTINCT turn_hash) AS observed_turns,
      sum(input_tokens) AS input_tokens,
      sum(cached_input_tokens) AS cached_input_tokens,
      sum(output_tokens) AS output_tokens,
      sum(reasoning_tokens) AS reasoning_tokens,
      sum(total_tokens) AS total_tokens
    FROM activity
    GROUP BY provider, utc_date
    ORDER BY utc_date, provider
  `).all(cutoffMs, cutoffMs);
}

export function semanticExecutionReportRows(database, cutoffMs) {
  return database.prepare(`
    SELECT
      target_kind, semantic_id, semantic_version, operation_id, tool_name,
      provider_id, provider_version, transport, lifecycle,
      count(*) AS executions,
      sum(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS completed,
      sum(CASE WHEN status = 'provider_error' THEN 1 ELSE 0 END) AS provider_errors,
      sum(CASE WHEN status = 'host_error' THEN 1 ELSE 0 END) AS host_errors,
      avg(duration_ms) AS average_duration_ms,
      avg(queue_ms) AS average_queue_ms,
      avg(provider_round_trip_ms) AS average_provider_round_trip_ms,
      sum(request_bytes) AS request_bytes,
      sum(response_bytes) AS response_bytes,
      min(completed_at_ms) AS first_observed_at_ms,
      max(completed_at_ms) AS last_observed_at_ms
    FROM semantic_execution_event
    WHERE completed_at_ms >= ?
    GROUP BY target_kind, semantic_id, semantic_version, operation_id, tool_name,
      provider_id, provider_version, transport, lifecycle
    ORDER BY executions DESC, provider_id, semantic_id, operation_id, tool_name
  `).all(cutoffMs);
}

export function latestContextSurfaceRows(database) {
  return database.prepare(`
    SELECT * FROM (
      SELECT *, row_number() OVER (
        PARTITION BY source_id ORDER BY imported_at_ms DESC, measurement_id DESC
      ) AS rank
      FROM context_surface_measurement
    ) WHERE rank = 1
    ORDER BY source_id
  `).all();
}

export function latestAgentHostDeployment(database) {
  return database.prepare(`
    SELECT * FROM agent_host_deployment_observation
    ORDER BY activated_at_ms DESC, observed_at_ms DESC, deployment_id DESC
    LIMIT 1
  `).get() ?? null;
}

export function deploymentToolRows(database, activatedAtMs) {
  return database.prepare(`
    SELECT
      provider,
      tool_name,
      count(*) AS calls,
      sum(CASE WHEN session_started_at_ms >= ? THEN 1 ELSE 0 END) AS fresh_session_calls,
      sum(CASE WHEN session_started_at_ms < ? THEN 1 ELSE 0 END) AS pre_activation_session_calls,
      sum(CASE WHEN session_started_at_ms IS NULL THEN 1 ELSE 0 END) AS unknown_session_start_calls
    FROM tool_event
    WHERE occurred_at_ms >= ?
    GROUP BY provider, tool_name
    ORDER BY calls DESC, provider, tool_name
  `).all(activatedAtMs, activatedAtMs, activatedAtMs);
}

export function deploymentRoutingEvents(database, activatedAtMs) {
  return database.prepare(`
    SELECT
      provider, session_hash, turn_hash, tool_name, route_class, status,
      retry_count, occurred_at_ms, event_id
    FROM tool_event
    WHERE occurred_at_ms >= ?
      AND session_started_at_ms >= ?
      AND session_hash IS NOT NULL
      AND turn_hash IS NOT NULL
      AND derived = 0
    ORDER BY provider, session_hash, turn_hash, occurred_at_ms, event_id
    LIMIT 50001
  `).all(activatedAtMs, activatedAtMs);
}

export function toolSequenceEvents(database, cutoffMs, openAdamOnly = false) {
  return database.prepare(`
    SELECT provider, session_hash, turn_hash, tool_name, occurred_at_ms, event_id
    FROM tool_event
    WHERE occurred_at_ms >= ?
      AND session_hash IS NOT NULL
      AND turn_hash IS NOT NULL
      AND derived = 0
      AND route_class = 'mcp'
      AND (? = 0 OR is_openadam = 1)
    ORDER BY provider, session_hash, turn_hash, occurred_at_ms, event_id
    LIMIT 50000
  `).all(cutoffMs, openAdamOnly ? 1 : 0);
}

export function observedSemanticToolNames(database) {
  return database.prepare(`
    SELECT DISTINCT tool_name
    FROM semantic_execution_event
    WHERE target_kind IN ('mcp-tool', 'mcp-operation') AND tool_name IS NOT NULL
    ORDER BY tool_name
  `).all().map((row) => row.tool_name);
}

export function schemaColumns(database) {
  const tables = [
    "source_cursor", "provider_checkpoint", "tool_event", "usage_event",
    "trace_cursor", "trace_model_step", "trace_tool_offer", "trace_tool_event", "trace_turn_event", "trace_adapter_health",
    "procedure_event", "capability_event",
    "direct_runtime_cursor", "direct_runtime_health", "semantic_execution_event",
    "context_surface_measurement",
    "agent_host_deployment_observation",
    "provider_health", "collection_run",
    "collector_lease"
  ];
  return tables.flatMap((table) => database.prepare(`PRAGMA table_info(${table})`).all().map((row) => ({
    table,
    name: row.name
  })));
}
