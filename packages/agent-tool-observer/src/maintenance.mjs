import fs from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1000;

const TARGETS = Object.freeze([
  {
    name: "toolEvents",
    count: "SELECT count(*) AS value FROM tool_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?",
    remove: "DELETE FROM tool_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?"
  },
  {
    name: "usageEvents",
    count: "SELECT count(*) AS value FROM usage_event WHERE COALESCE(occurred_at_ms, recorded_at_ms) < ?",
    remove: "DELETE FROM usage_event WHERE COALESCE(occurred_at_ms, recorded_at_ms) < ?"
  },
  {
    name: "traceModelSteps",
    count: "SELECT count(*) AS value FROM trace_model_step WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?",
    remove: "DELETE FROM trace_model_step WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?"
  },
  {
    name: "traceToolEvents",
    count: "SELECT count(*) AS value FROM trace_tool_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?",
    remove: "DELETE FROM trace_tool_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?"
  },
  {
    name: "traceTurnEvents",
    count: "SELECT count(*) AS value FROM trace_turn_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?",
    remove: "DELETE FROM trace_turn_event WHERE COALESCE(completed_at_ms, occurred_at_ms, recorded_at_ms) < ?"
  },
  {
    name: "procedureEvents",
    count: "SELECT count(*) AS value FROM procedure_event WHERE completed_at_ms < ?",
    remove: "DELETE FROM procedure_event WHERE completed_at_ms < ?"
  },
  {
    name: "semanticExecutionEvents",
    count: "SELECT count(*) AS value FROM semantic_execution_event WHERE completed_at_ms < ?",
    remove: "DELETE FROM semantic_execution_event WHERE completed_at_ms < ?"
  },
  {
    name: "contextSurfaceMeasurements",
    count: `SELECT count(*) AS value FROM context_surface_measurement
      WHERE imported_at_ms < ? AND measurement_id NOT IN (
        SELECT measurement_id FROM (
          SELECT measurement_id, row_number() OVER (
            PARTITION BY source_id ORDER BY imported_at_ms DESC, measurement_id DESC
          ) AS rank FROM context_surface_measurement
        ) WHERE rank = 1
      )`,
    remove: `DELETE FROM context_surface_measurement
      WHERE imported_at_ms < ? AND measurement_id NOT IN (
        SELECT measurement_id FROM (
          SELECT measurement_id, row_number() OVER (
            PARTITION BY source_id ORDER BY imported_at_ms DESC, measurement_id DESC
          ) AS rank FROM context_surface_measurement
        ) WHERE rank = 1
      )`
  },
  {
    name: "agentHostDeploymentObservations",
    count: `SELECT count(*) AS value FROM agent_host_deployment_observation
      WHERE observed_at_ms < ? AND deployment_id != COALESCE((
        SELECT deployment_id FROM agent_host_deployment_observation
        ORDER BY activated_at_ms DESC, observed_at_ms DESC, deployment_id DESC LIMIT 1
      ), '')`,
    remove: `DELETE FROM agent_host_deployment_observation
      WHERE observed_at_ms < ? AND deployment_id != COALESCE((
        SELECT deployment_id FROM agent_host_deployment_observation
        ORDER BY activated_at_ms DESC, observed_at_ms DESC, deployment_id DESC LIMIT 1
      ), '')`
  },
  {
    name: "collectionRuns",
    count: "SELECT count(*) AS value FROM collection_run WHERE COALESCE(completed_at_ms, started_at_ms) < ?",
    remove: "DELETE FROM collection_run WHERE COALESCE(completed_at_ms, started_at_ms) < ?"
  }
]);

function databaseBytes(database) {
  return Number(database.prepare("PRAGMA page_count").get().page_count)
    * Number(database.prepare("PRAGMA page_size").get().page_size);
}

function fileBytes(filePath) {
  try {
    return fs.lstatSync(filePath).size;
  } catch {
    return null;
  }
}

export function maintainDatabase(database, config, options = {}, nowMs = Date.now()) {
  const cutoffMs = nowMs - config.limits.retentionDays * DAY_MS;
  const dryRun = options.dryRun === true;
  const before = {
    databaseBytes: databaseBytes(database),
    fileBytes: fileBytes(config.databasePath)
  };
  const eligible = Object.fromEntries(TARGETS.map((target) => [
    target.name,
    Number(database.prepare(target.count).get(cutoffMs).value)
  ]));
  const capabilityStages = Number(database.prepare(`
    SELECT count(*) AS value FROM capability_event
    WHERE procedure_event_id IN (
      SELECT event_id FROM procedure_event WHERE completed_at_ms < ?
    )
  `).get(cutoffMs).value);
  eligible.capabilityEvents = capabilityStages;
  if (dryRun) {
    return {
      status: "preview",
      dryRun: true,
      retentionDays: config.limits.retentionDays,
      cutoffMs,
      eligible,
      before,
      after: before,
      reclaimedFileBytes: 0
    };
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const target of TARGETS) database.prepare(target.remove).run(cutoffMs);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const after = {
    databaseBytes: databaseBytes(database),
    fileBytes: fileBytes(config.databasePath)
  };
  return {
    status: "completed",
    dryRun: false,
    retentionDays: config.limits.retentionDays,
    cutoffMs,
    removed: eligible,
    before,
    after,
    reclaimedFileBytes: before.fileBytes === null || after.fileBytes === null
      ? null
      : Math.max(0, before.fileBytes - after.fileBytes)
  };
}
