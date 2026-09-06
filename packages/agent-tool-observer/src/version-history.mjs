// Longitudinal metadata survives raw-event retention. Hash receipts prevent a
// rotated or replayed source from adding the same execution a second time.
export const VERSION_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS semantic_execution_receipt (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) = 64)
) STRICT;
CREATE TABLE IF NOT EXISTS semantic_version_history (
  provider_id TEXT NOT NULL, provider_version TEXT NOT NULL, purpose TEXT NOT NULL,
  executions INTEGER NOT NULL, completed INTEGER NOT NULL,
  provider_errors INTEGER NOT NULL, host_errors INTEGER NOT NULL,
  outcome_reported INTEGER NOT NULL, outcome_partial INTEGER NOT NULL,
  outcome_errors INTEGER NOT NULL, outcome_cancelled INTEGER NOT NULL,
  items_total INTEGER NOT NULL, items_errors INTEGER NOT NULL, items_cancelled INTEGER NOT NULL,
  first_observed_at_ms INTEGER NOT NULL, last_observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider_id, provider_version, purpose)
) STRICT;
`;

const COUNTERS = ['executions', 'completed', 'provider_errors', 'host_errors', 'outcome_reported',
  'outcome_partial', 'outcome_errors', 'outcome_cancelled', 'items_total', 'items_errors', 'items_cancelled'];
const KEYS = ['provider_id', 'provider_version', 'purpose'];
const RANGE = ['first_observed_at_ms', 'last_observed_at_ms'];

function liveRows(before = false) {
  return `SELECT e.provider_id, coalesce(e.provider_version, '') AS provider_version,
    coalesce(d.purpose, 'unspecified') AS purpose,
    count(*) AS executions,
    sum(e.status = 'ok') AS completed, sum(e.status = 'provider_error') AS provider_errors,
    sum(e.status = 'host_error') AS host_errors,
    sum(coalesce(d.outcome_status = 'reported', 0)) AS outcome_reported,
    sum(coalesce(json_extract(d.outcome_json, '$.status') = 'partial', 0)) AS outcome_partial,
    sum(coalesce(json_extract(d.outcome_json, '$.status') = 'error', 0)) AS outcome_errors,
    sum(coalesce(json_extract(d.outcome_json, '$.status') = 'cancelled', 0)) AS outcome_cancelled,
    sum(coalesce(json_extract(d.outcome_json, '$.items.total'), 0)) AS items_total,
    sum(coalesce(json_extract(d.outcome_json, '$.items.errors'), 0)) AS items_errors,
    sum(coalesce(json_extract(d.outcome_json, '$.items.cancelled'), 0)) AS items_cancelled,
    min(e.completed_at_ms) AS first_observed_at_ms, max(e.completed_at_ms) AS last_observed_at_ms
    FROM semantic_execution_event e LEFT JOIN semantic_execution_detail d USING(event_id)
    WHERE NOT EXISTS(SELECT 1 FROM semantic_execution_receipt r WHERE r.event_id = e.event_id)
    ${before ? 'AND e.completed_at_ms < ?' : ''}
    GROUP BY e.provider_id, coalesce(e.provider_version, ''), coalesce(d.purpose, 'unspecified')`;
}

// Caller owns the retention transaction: aggregate, receipt, and deletion are atomic.
export function archiveSemanticVersions(database, cutoffMs) {
  const columns = [...KEYS, ...COUNTERS, ...RANGE];
  database.prepare(`INSERT INTO semantic_version_history(${columns.join(',')})
    ${liveRows(true)}
    ON CONFLICT(${KEYS.join(',')}) DO UPDATE SET
    ${COUNTERS.map((key) => `${key} = ${key} + excluded.${key}`).join(',')},
    first_observed_at_ms = min(first_observed_at_ms, excluded.first_observed_at_ms),
    last_observed_at_ms = max(last_observed_at_ms, excluded.last_observed_at_ms)
  `).run(cutoffMs);
  database.prepare(`INSERT OR IGNORE INTO semantic_execution_receipt(event_id)
    SELECT event_id FROM semantic_execution_event WHERE completed_at_ms < ?`).run(cutoffMs);
}

export function semanticVersionHistory(database) {
  const rows = database.prepare(`SELECT ${KEYS.join(',')},
    ${COUNTERS.map((key) => `sum(${key}) AS ${key}`).join(',')},
    min(first_observed_at_ms) AS first_observed_at_ms, max(last_observed_at_ms) AS last_observed_at_ms
    FROM (${liveRows()} UNION ALL SELECT * FROM semantic_version_history)
    GROUP BY ${KEYS.join(',')} ORDER BY last_observed_at_ms DESC, provider_id, provider_version, purpose`).all();
  return {
    basis: 'retained-and-archived-direct-runtime-metadata',
    earlierHistory: 'not-reconstructed', retention: 'until-explicit-observer-state-removal',
    versions: rows.map((r) => ({
      providerId: r.provider_id, providerVersion: r.provider_version || null, purpose: r.purpose,
      executions: r.executions, completed: r.completed, providerErrors: r.provider_errors, hostErrors: r.host_errors,
      reportedOutcomes: r.outcome_reported, partialResults: r.outcome_partial,
      resultErrors: r.outcome_errors, resultCancellations: r.outcome_cancelled,
      batchItems: r.items_total, itemErrors: r.items_errors, itemCancellations: r.items_cancelled,
      firstObservedAtMs: r.first_observed_at_ms, lastObservedAtMs: r.last_observed_at_ms,
    })),
  };
}
