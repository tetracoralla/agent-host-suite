import { ObserverError } from "./errors.mjs";

const TOOL_TIME = "COALESCE(occurred_at_ms, completed_at_ms, recorded_at_ms)";
const USAGE_TIME = "COALESCE(occurred_at_ms, recorded_at_ms)";
const validatedDatabases = new WeakSet();

const REQUIRED_COLUMNS = Object.freeze({
  tool_event: [
    "event_id", "provider", "session_hash", "turn_hash", "call_hash", "session_started_at_ms",
    "occurred_at_ms", "completed_at_ms", "tool_name", "tool_namespace", "route_class",
    "is_openadam", "derived", "status", "duration_ms", "retry_count", "request_bytes",
    "response_bytes", "source_format", "recorded_at_ms"
  ],
  usage_event: [
    "event_id", "provider", "session_hash", "turn_hash", "occurred_at_ms", "input_tokens",
    "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "duration_ms",
    "source_format", "recorded_at_ms"
  ]
});

export function assertRetainedTaskSchema(database) {
  if (validatedDatabases.has(database)) return;
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    let rows;
    try {
      rows = database.prepare(`PRAGMA table_info(${table})`).all();
    } catch (error) {
      throw new ObserverError("TASK_STATE_SCHEMA_UNAVAILABLE", "Observer task metadata schema is unavailable", {
        cause: error?.code ?? null
      });
    }
    const present = new Set(rows.map((row) => row.name));
    const missing = required.filter((name) => !present.has(name));
    if (rows.length === 0 || missing.length > 0) {
      throw new ObserverError("TASK_STATE_SCHEMA_UNAVAILABLE", "Observer task metadata schema is unavailable", {
        table,
        missingColumns: missing
      });
    }
  }
  validatedDatabases.add(database);
}

function timeSelection(provider, range, sessionHash = null) {
  const parameters = [provider];
  const common = ["provider = ?", "session_hash IS NOT NULL"];
  if (sessionHash !== null) {
    common.push("session_hash = ?");
    parameters.push(sessionHash);
  }
  const tool = [...common];
  const usage = [...common];
  const toolParameters = [...parameters];
  const usageParameters = [...parameters];
  if (range.fromMs !== null) {
    tool.push(`${TOOL_TIME} >= ?`);
    usage.push(`${USAGE_TIME} >= ?`);
    toolParameters.push(range.fromMs);
    usageParameters.push(range.fromMs);
  }
  if (range.toMs !== null) {
    tool.push(`${TOOL_TIME} <= ?`);
    usage.push(`${USAGE_TIME} <= ?`);
    toolParameters.push(range.toMs);
    usageParameters.push(range.toMs);
  }
  return {
    toolSql: tool.join(" AND "),
    usageSql: usage.join(" AND "),
    parameters: [...toolParameters, ...usageParameters]
  };
}

function activityUnion(provider, range, sessionHash = null) {
  const selection = timeSelection(provider, range, sessionHash);
  return {
    sql: `
      SELECT session_hash, turn_hash, session_started_at_ms, ${TOOL_TIME} AS event_time,
        1 AS tool_observation, CASE WHEN derived = 0 THEN 1 ELSE 0 END AS direct_call,
        CASE WHEN derived = 1 THEN 1 ELSE 0 END AS static_reference,
        CASE WHEN status = 'completed' THEN 1 ELSE 0 END AS completed,
        CASE WHEN status = 'error' THEN 1 ELSE 0 END AS errors,
        CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END AS cancelled,
        CASE WHEN status IN ('observed', 'unknown') THEN 1 ELSE 0 END AS outcome_unknown,
        0 AS usage_record
      FROM tool_event WHERE ${selection.toolSql}
      UNION ALL
      SELECT session_hash, turn_hash, NULL AS session_started_at_ms, ${USAGE_TIME} AS event_time,
        0, 0, 0, 0, 0, 0, 0, 1
      FROM usage_event WHERE ${selection.usageSql}
    `,
    parameters: selection.parameters
  };
}

export function readRetainedTaskSourceRows(database, provider, range, limit) {
  const selection = activityUnion(provider, range);
  return database.prepare(`
    WITH activity AS (${selection.sql})
    SELECT session_hash,
      MIN(session_started_at_ms) AS session_started_at_ms,
      MIN(event_time) AS first_event_at_ms,
      MAX(event_time) AS last_event_at_ms,
      COUNT(DISTINCT turn_hash) AS observed_turns,
      SUM(tool_observation) AS tool_observations,
      SUM(direct_call) AS direct_calls,
      SUM(static_reference) AS static_references,
      SUM(completed) AS completed,
      SUM(errors) AS errors,
      SUM(cancelled) AS cancelled,
      SUM(outcome_unknown) AS outcome_unknown,
      SUM(usage_record) AS usage_records
    FROM activity
    GROUP BY session_hash
    ORDER BY last_event_at_ms DESC, session_hash ASC
    LIMIT ?
  `).all(...selection.parameters, limit);
}

export function readRetainedTaskSummary(database, provider, range, sessionHash) {
  const selection = activityUnion(provider, range, sessionHash);
  const row = database.prepare(`
    WITH activity AS (${selection.sql})
    SELECT session_hash,
      MIN(session_started_at_ms) AS session_started_at_ms,
      MIN(event_time) AS first_event_at_ms,
      MAX(event_time) AS last_event_at_ms,
      COUNT(*) AS event_count,
      COUNT(DISTINCT turn_hash) AS observed_turns,
      SUM(tool_observation) AS tool_observations,
      SUM(direct_call) AS direct_calls,
      SUM(static_reference) AS static_references,
      SUM(completed) AS completed,
      SUM(errors) AS errors,
      SUM(cancelled) AS cancelled,
      SUM(outcome_unknown) AS outcome_unknown,
      SUM(usage_record) AS usage_records
    FROM activity
    GROUP BY session_hash
  `).get(...selection.parameters);
  return row ?? null;
}

export function readRetainedTaskRows(database, provider, range, sessionHash, limit) {
  const selection = timeSelection(provider, range, sessionHash);
  return database.prepare(`
    WITH task_events AS (
      SELECT event_id, 'tool-observation' AS event_kind, ${TOOL_TIME} AS event_time,
        session_hash, turn_hash, call_hash, occurred_at_ms, completed_at_ms,
        tool_name, tool_namespace, route_class, is_openadam, derived, status,
        duration_ms, retry_count, request_bytes, response_bytes,
        NULL AS input_tokens, NULL AS cached_input_tokens, NULL AS output_tokens,
        NULL AS reasoning_tokens, NULL AS total_tokens,
        source_format
      FROM tool_event WHERE ${selection.toolSql}
      UNION ALL
      SELECT event_id, 'usage-observation', ${USAGE_TIME},
        session_hash, turn_hash, NULL, occurred_at_ms, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL,
        duration_ms, NULL, NULL, NULL,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
        source_format
      FROM usage_event WHERE ${selection.usageSql}
    )
    SELECT * FROM task_events
    ORDER BY event_time ASC, event_kind ASC, event_id ASC
    LIMIT ?
  `).all(...selection.parameters, limit);
}
