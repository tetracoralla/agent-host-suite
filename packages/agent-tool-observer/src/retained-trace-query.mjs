import { ObserverError } from "./errors.mjs";

const EFFECTIVE_TIME = "COALESCE(occurred_at_ms, completed_at_ms, recorded_at_ms)";
const MAX_ADAPTER_PROVENANCE = 64;
const validatedDatabases = new WeakSet();

const REQUIRED_COLUMNS = Object.freeze({
  trace_model_step: [
    "event_id", "provider", "adapter_id", "adapter_version", "provider_version", "session_hash",
    "turn_hash", "request_hash", "occurred_at_ms", "completed_at_ms", "model_id", "query_source",
    "finish_reason", "status", "attempt", "duration_ms", "request_bytes", "response_bytes",
    "request_message_count", "offered_tool_count", "emitted_tool_call_count", "input_tokens",
    "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "rationale_present",
    "stable_error_code", "source_format", "recorded_at_ms"
  ],
  trace_tool_offer: ["event_id", "tool_name", "tool_namespace", "route_class", "is_openadam"],
  trace_tool_event: [
    "event_id", "provider", "adapter_id", "adapter_version", "provider_version", "session_hash",
    "turn_hash", "request_hash", "call_hash", "kind", "occurred_at_ms", "completed_at_ms",
    "tool_name", "tool_namespace", "route_class", "is_openadam", "status", "request_bytes",
    "response_bytes", "stable_error_code", "source_format", "recorded_at_ms"
  ],
  trace_turn_event: [
    "event_id", "provider", "adapter_id", "adapter_version", "provider_version", "session_hash",
    "turn_hash", "occurred_at_ms", "completed_at_ms", "status", "stable_reason",
    "stable_error_code", "source_format", "recorded_at_ms"
  ]
});

export function assertRetainedTraceSchema(database) {
  if (validatedDatabases.has(database)) return;
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    let rows;
    try {
      rows = database.prepare(`PRAGMA table_info(${table})`).all();
    } catch (error) {
      throw new ObserverError("TRACE_STATE_SCHEMA_UNAVAILABLE", "Observer trace metadata schema is unavailable", {
        cause: error?.code ?? null
      });
    }
    const present = new Set(rows.map((row) => row.name));
    const missing = required.filter((name) => !present.has(name));
    if (rows.length === 0 || missing.length > 0) {
      throw new ObserverError("TRACE_STATE_SCHEMA_UNAVAILABLE", "Observer trace metadata schema is unavailable", {
        table,
        missingColumns: missing
      });
    }
  }
  validatedDatabases.add(database);
}

function whereClause(provider, range, sessionHash = null) {
  const clauses = ["provider = ?", "session_hash IS NOT NULL"];
  const parameters = [provider];
  if (sessionHash !== null) {
    clauses.push("session_hash = ?");
    parameters.push(sessionHash);
  }
  if (range.fromMs !== null) {
    clauses.push(`${EFFECTIVE_TIME} >= ?`);
    parameters.push(range.fromMs);
  }
  if (range.toMs !== null) {
    clauses.push(`${EFFECTIVE_TIME} <= ?`);
    parameters.push(range.toMs);
  }
  return { sql: clauses.join(" AND "), parameters };
}

function selectParts(provider, range, sessionHash, projections) {
  const parts = [];
  const parameters = [];
  for (const projection of projections) {
    const where = whereClause(provider, range, sessionHash);
    parts.push(`SELECT ${projection.columns} FROM ${projection.table} WHERE ${where.sql}`);
    parameters.push(...where.parameters);
  }
  return { sql: parts.join(" UNION ALL "), parameters };
}

const SOURCE_PROJECTIONS = Object.freeze([
  { table: "trace_model_step", columns: `session_hash, 'model-step' AS event_kind, ${EFFECTIVE_TIME} AS event_time` },
  { table: "trace_tool_event", columns: `session_hash, kind AS event_kind, ${EFFECTIVE_TIME} AS event_time` },
  { table: "trace_turn_event", columns: `session_hash, 'turn-end' AS event_kind, ${EFFECTIVE_TIME} AS event_time` }
]);

const SUMMARY_PROJECTIONS = Object.freeze([
  { table: "trace_model_step", columns: `adapter_id, adapter_version, provider_version, source_format, ${EFFECTIVE_TIME} AS event_time` },
  { table: "trace_tool_event", columns: `adapter_id, adapter_version, provider_version, source_format, ${EFFECTIVE_TIME} AS event_time` },
  { table: "trace_turn_event", columns: `adapter_id, adapter_version, provider_version, source_format, ${EFFECTIVE_TIME} AS event_time` }
]);

const MODEL_EVENT_COLUMNS = `
  event_id, 'model-step' AS event_kind, 0 AS kind_order, ${EFFECTIVE_TIME} AS event_time,
  provider, adapter_id, adapter_version, provider_version, session_hash, turn_hash, request_hash,
  NULL AS call_hash, occurred_at_ms, completed_at_ms,
  model_id, query_source, finish_reason, status, attempt, duration_ms,
  request_bytes, response_bytes, request_message_count, offered_tool_count, emitted_tool_call_count,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
  rationale_present, stable_error_code, NULL AS stable_reason,
  NULL AS tool_name, NULL AS tool_namespace, NULL AS route_class, NULL AS is_openadam, source_format`;

const TOOL_EVENT_COLUMNS = `
  event_id, kind AS event_kind,
  CASE kind WHEN 'tool-call' THEN 1 WHEN 'tool-result' THEN 2 ELSE 3 END AS kind_order,
  ${EFFECTIVE_TIME} AS event_time,
  provider, adapter_id, adapter_version, provider_version, session_hash, turn_hash, request_hash,
  call_hash, occurred_at_ms, completed_at_ms,
  NULL AS model_id, NULL AS query_source, NULL AS finish_reason, status,
  NULL AS attempt, NULL AS duration_ms, request_bytes, response_bytes,
  NULL AS request_message_count, NULL AS offered_tool_count, NULL AS emitted_tool_call_count,
  NULL AS input_tokens, NULL AS cached_input_tokens, NULL AS output_tokens,
  NULL AS reasoning_tokens, NULL AS total_tokens, NULL AS rationale_present,
  stable_error_code, NULL AS stable_reason,
  tool_name, tool_namespace, route_class, is_openadam, source_format`;

const TURN_EVENT_COLUMNS = `
  event_id, 'turn-end' AS event_kind, 3 AS kind_order, ${EFFECTIVE_TIME} AS event_time,
  provider, adapter_id, adapter_version, provider_version, session_hash, turn_hash,
  NULL AS request_hash, NULL AS call_hash, occurred_at_ms, completed_at_ms,
  NULL AS model_id, NULL AS query_source, NULL AS finish_reason, status,
  NULL AS attempt, NULL AS duration_ms, NULL AS request_bytes, NULL AS response_bytes,
  NULL AS request_message_count, NULL AS offered_tool_count, NULL AS emitted_tool_call_count,
  NULL AS input_tokens, NULL AS cached_input_tokens, NULL AS output_tokens,
  NULL AS reasoning_tokens, NULL AS total_tokens, NULL AS rationale_present,
  stable_error_code, stable_reason,
  NULL AS tool_name, NULL AS tool_namespace, NULL AS route_class, NULL AS is_openadam, source_format`;

const EVENT_PROJECTIONS = Object.freeze([
  { table: "trace_model_step", columns: MODEL_EVENT_COLUMNS },
  { table: "trace_tool_event", columns: TOOL_EVENT_COLUMNS },
  { table: "trace_turn_event", columns: TURN_EVENT_COLUMNS }
]);

export function readRetainedTraceSourceRows(database, provider, range, limit) {
  const selection = selectParts(provider, range, null, SOURCE_PROJECTIONS);
  return database.prepare(`
    WITH trace_events AS (${selection.sql})
    SELECT
      session_hash,
      MIN(event_time) AS first_event_at_ms,
      MAX(event_time) AS last_event_at_ms,
      COUNT(*) AS total_events,
      SUM(CASE WHEN event_kind = 'model-step' THEN 1 ELSE 0 END) AS model_steps,
      SUM(CASE WHEN event_kind = 'tool-call' THEN 1 ELSE 0 END) AS tool_calls,
      SUM(CASE WHEN event_kind = 'tool-result' THEN 1 ELSE 0 END) AS tool_results,
      SUM(CASE WHEN event_kind = 'turn-end' THEN 1 ELSE 0 END) AS turn_ends
    FROM trace_events
    GROUP BY session_hash
    ORDER BY last_event_at_ms DESC, session_hash ASC
    LIMIT ?
  `).all(...selection.parameters, limit);
}

export function readRetainedTraceRows(database, provider, range, sessionHash, limit) {
  const selection = selectParts(provider, range, sessionHash, EVENT_PROJECTIONS);
  return database.prepare(`
    WITH trace_events AS (${selection.sql})
    SELECT * FROM trace_events
    ORDER BY event_time ASC, kind_order ASC, event_id ASC
    LIMIT ?
  `).all(...selection.parameters, limit);
}

export function readRetainedTraceSummary(database, provider, range, sessionHash) {
  const selection = selectParts(provider, range, sessionHash, SUMMARY_PROJECTIONS);
  const rows = database.prepare(`
    WITH trace_events AS (${selection.sql})
    SELECT adapter_id, adapter_version, provider_version, source_format,
      MIN(event_time) AS first_event_at_ms, MAX(event_time) AS last_event_at_ms, COUNT(*) AS event_count
    FROM trace_events
    GROUP BY adapter_id, adapter_version, provider_version, source_format
    ORDER BY adapter_id, adapter_version, provider_version, source_format
    LIMIT ?
  `).all(...selection.parameters, MAX_ADAPTER_PROVENANCE + 1);
  if (rows.length === 0) return null;
  if (rows.length > MAX_ADAPTER_PROVENANCE) {
    throw new ObserverError(
      "TRACE_ADAPTER_PROVENANCE_LIMIT",
      "Retained trace metadata exceeds the supported adapter-provenance bound"
    );
  }
  return {
    firstEventAtMs: Math.min(...rows.map((row) => row.first_event_at_ms)),
    lastEventAtMs: Math.max(...rows.map((row) => row.last_event_at_ms)),
    eventCount: rows.reduce((sum, row) => sum + row.event_count, 0),
    adapters: rows.map((row) => ({
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      providerVersion: row.provider_version,
      sourceFormat: row.source_format
    }))
  };
}

export function readRetainedTraceOffers(database, eventIds, maximumPerStep) {
  const output = new Map();
  for (let offset = 0; offset < eventIds.length; offset += 500) {
    const chunk = eventIds.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT event_id, tool_name, tool_namespace, route_class, is_openadam
      FROM trace_tool_offer
      WHERE event_id IN (${placeholders})
      ORDER BY event_id, tool_name
    `).all(...chunk);
    for (const row of rows) {
      const record = output.get(row.event_id) ?? { values: [], totalStored: 0 };
      record.totalStored += 1;
      if (record.values.length < maximumPerStep) record.values.push({
        toolName: row.tool_name,
        toolNamespace: row.tool_namespace,
        routeClass: row.route_class,
        isOpenAdam: row.is_openadam === 1
      });
      output.set(row.event_id, record);
    }
  }
  return output;
}
