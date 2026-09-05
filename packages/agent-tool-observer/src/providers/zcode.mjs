import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { nonNegativeInteger, finiteNonNegativeNumber } from "../core/classify.mjs";
import { getProviderCheckpoint, putProviderCheckpoint, putToolEvent, putUsageEvent } from "../db.mjs";
import { ObserverError, stableErrorCode } from "../errors.mjs";
import { normalizedToolFields } from "./jsonl-provider.mjs";

function emptyHealth(scannedAtMs) {
  return {
    provider: "zcode",
    status: "ok",
    errorCode: null,
    filesSeen: 1,
    filesRead: 0,
    bytesRead: 0,
    linesRead: 0,
    eventsWritten: 0,
    skippedLines: 0,
    backlogSources: 0,
    scannedAtMs
  };
}

function mapStatus(value) {
  if (value === "completed") return "completed";
  if (value === "error") return "error";
  if (value === "cancelled") return "cancelled";
  if (value === "running") return "observed";
  return "unknown";
}

function hasTable(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumns(database, table, required) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  return required.every((column) => columns.has(column));
}

function checkpointBounds(database, stream, sourceFingerprint, minimumMtimeMs) {
  const checkpoint = getProviderCheckpoint(database, "zcode", stream, sourceFingerprint);
  if (checkpoint === null) {
    return {
      exists: false,
      lastStartedAtMs: minimumMtimeMs,
      lastStartedCount: 0,
      lastScanAtMs: minimumMtimeMs
    };
  }
  return {
    exists: true,
    lastStartedAtMs: Math.max(minimumMtimeMs, checkpoint.lastStartedAtMs),
    lastStartedCount: checkpoint.lastStartedAtMs < minimumMtimeMs ? 0 : checkpoint.lastStartedCount,
    lastScanAtMs: Math.max(minimumMtimeMs, checkpoint.lastScanAtMs)
  };
}

function validateSourceRow(row) {
  if ((typeof row.id !== "string" && typeof row.id !== "number") || String(row.id).length === 0) {
    throw new ObserverError("SOURCE_ROW_INVALID", "ZCode usage row has no stable identifier");
  }
  if (nonNegativeInteger(row.started_at) === null) {
    throw new ObserverError("SOURCE_ROW_INVALID", "ZCode usage row has no valid start timestamp");
  }
}

function readNewRows(source, table, columns, bounds, limit) {
  if (limit <= 0) return [];
  if (!bounds.exists) {
    return source.prepare(`
      SELECT ${columns}
      FROM ${table}
      WHERE started_at >= ?
      ORDER BY started_at, id
      LIMIT ?
    `).all(bounds.lastStartedAtMs, limit + 1);
  }
  const boundaryRows = source.prepare(`
    SELECT ${columns}
    FROM ${table}
    WHERE started_at = ?
    ORDER BY started_at, id
    LIMIT ? OFFSET ?
  `).all(bounds.lastStartedAtMs, limit + 1, bounds.lastStartedCount);
  if (boundaryRows.length >= limit + 1) return boundaryRows;
  const laterRows = source.prepare(`
    SELECT ${columns}
    FROM ${table}
    WHERE started_at > ?
    ORDER BY started_at, id
    LIMIT ?
  `).all(bounds.lastStartedAtMs, limit + 1 - boundaryRows.length);
  return boundaryRows.concat(laterRows);
}

function nextNewBounds(rows, bounds) {
  let lastStartedAtMs = bounds.lastStartedAtMs;
  let lastStartedCount = bounds.lastStartedCount;
  for (const row of rows) {
    const startedAtMs = nonNegativeInteger(row.started_at);
    if (startedAtMs === lastStartedAtMs) lastStartedCount += 1;
    else {
      lastStartedAtMs = startedAtMs;
      lastStartedCount = 1;
    }
  }
  return { lastStartedAtMs, lastStartedCount };
}

function streamAllowances(totalLimit) {
  const toolLimit = Math.ceil(totalLimit / 2);
  return { toolLimit, usageLimit: totalLimit - toolLimit };
}

function splitNewAndRefresh(limit, hasCheckpoint) {
  if (!hasCheckpoint || limit < 2) return { newLimit: limit, refreshLimit: 0 };
  const refreshLimit = Math.max(1, Math.floor(limit / 4));
  return { newLimit: limit - refreshLimit, refreshLimit };
}

function readRefreshRows(source, table, columns, bounds, limit) {
  if (!bounds.exists || limit <= 0) return [];
  return source.prepare(`
    SELECT ${columns}
    FROM ${table}
    WHERE started_at <= ? AND completed_at >= ?
    ORDER BY completed_at, started_at, id
    LIMIT ?
  `).all(bounds.lastStartedAtMs, bounds.lastScanAtMs, limit + 1);
}

export function scanZcode({
  database,
  config,
  minimumMtimeMs,
  scannedAtMs,
  deadlineMs = Number.MAX_SAFE_INTEGER,
  maximumRows = config.limits.maxLinesPerRun
}) {
  const health = emptyHealth(scannedAtMs);
  let stat;
  try {
    stat = fs.lstatSync(config.zcodeDatabasePath);
  } catch (error) {
    if (error.code === "ENOENT") return { ...health, status: "missing", errorCode: "SOURCE_DATABASE_MISSING", filesSeen: 0 };
    return { ...health, status: "error", errorCode: stableErrorCode(error) };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ...health, status: "error", errorCode: "SOURCE_DATABASE_INVALID" };
  }

  let source;
  try {
    source = new DatabaseSync(config.zcodeDatabasePath, { readOnly: true });
    source.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
    const supported = hasTable(source, "tool_usage")
      && hasTable(source, "model_usage")
      && hasColumns(source, "tool_usage", [
        "id", "session_id", "turn_id", "tool_call_id", "tool_name", "status",
        "started_at", "completed_at", "duration_ms", "retry_count"
      ])
      && hasColumns(source, "model_usage", [
        "id", "session_id", "turn_id", "status", "started_at", "completed_at",
        "duration_ms", "input_tokens", "output_tokens", "reasoning_tokens",
        "cache_read_input_tokens", "computed_total_tokens"
      ]);
    if (!supported) return { ...health, status: "error", errorCode: "SOURCE_SCHEMA_UNSUPPORTED" };
    const hasSessionStart = hasTable(source, "session") && hasColumns(source, "session", ["id", "time_created"]);

    const sourceFingerprint = hashIdentifier("zcode-source-identity", `${stat.dev}:${stat.ino}`);
    const toolBounds = checkpointBounds(database, "tool_usage", sourceFingerprint, minimumMtimeMs);
    const usageBounds = checkpointBounds(database, "model_usage", sourceFingerprint, minimumMtimeMs);
    const { toolLimit, usageLimit } = streamAllowances(maximumRows);
    const toolAllocation = splitNewAndRefresh(toolLimit, toolBounds.exists);
    const usageAllocation = splitNewAndRefresh(usageLimit, usageBounds.exists);
    const sessionStartColumn = (table) => hasSessionStart
      ? `(SELECT time_created FROM session AS session_source WHERE session_source.id = ${table}.session_id LIMIT 1) AS session_started_at`
      : "NULL AS session_started_at";
    const toolColumns = `id, session_id, turn_id, tool_call_id, tool_name, status,
      started_at, completed_at, duration_ms, retry_count, ${sessionStartColumn("tool_usage")}`;
    const usageColumns = `id, session_id, turn_id, status, started_at, completed_at,
      duration_ms, input_tokens, output_tokens, reasoning_tokens,
      cache_read_input_tokens, computed_total_tokens, ${sessionStartColumn("model_usage")}`;
    const toolNewCandidates = readNewRows(source, "tool_usage", toolColumns, toolBounds, toolAllocation.newLimit);
    const toolRefreshCandidates = readRefreshRows(source, "tool_usage", toolColumns, toolBounds, toolAllocation.refreshLimit);
    const usageNewCandidates = readNewRows(source, "model_usage", usageColumns, usageBounds, usageAllocation.newLimit);
    const usageRefreshCandidates = readRefreshRows(source, "model_usage", usageColumns, usageBounds, usageAllocation.refreshLimit);
    const toolNew = toolNewCandidates.slice(0, toolAllocation.newLimit);
    const toolRefresh = toolRefreshCandidates.slice(0, toolAllocation.refreshLimit);
    const usageNew = usageNewCandidates.slice(0, usageAllocation.newLimit);
    const usageRefresh = usageRefreshCandidates.slice(0, usageAllocation.refreshLimit);
    let deadlineReached = Date.now() >= deadlineMs;
    const processedToolNew = [];
    const processedUsageNew = [];

    database.exec("BEGIN IMMEDIATE");
    const writeTool = (row, isNew) => {
      validateSourceRow(row);
      const normalized = normalizedToolFields(row.tool_name);
      health.eventsWritten += putToolEvent(database, {
        eventId: eventIdentifier("zcode", "tool", row.id),
        provider: "zcode",
        sourceId: hashIdentifier("source:zcode", config.zcodeDatabasePath),
        sessionHash: hashIdentifier("zcode-session", row.session_id),
        turnHash: hashIdentifier("zcode-turn", row.turn_id),
        callHash: hashIdentifier("zcode-call", row.tool_call_id),
        sessionStartedAtMs: nonNegativeInteger(row.session_started_at),
        occurredAtMs: nonNegativeInteger(row.started_at),
        completedAtMs: nonNegativeInteger(row.completed_at),
        ...normalized,
        derived: false,
        status: mapStatus(row.status),
        durationMs: finiteNonNegativeNumber(row.duration_ms),
        retryCount: nonNegativeInteger(row.retry_count),
        sourceFormat: "zcode-usage-sqlite",
        recordedAtMs: scannedAtMs
      });
      if (isNew) processedToolNew.push(row);
      health.linesRead += 1;
    };
    const writeUsage = (row, isNew) => {
      validateSourceRow(row);
      health.eventsWritten += putUsageEvent(database, {
        eventId: eventIdentifier("zcode", "model-usage", row.id),
        provider: "zcode",
        sessionHash: hashIdentifier("zcode-session", row.session_id),
        turnHash: hashIdentifier("zcode-turn", row.turn_id),
        occurredAtMs: nonNegativeInteger(row.started_at),
        inputTokens: nonNegativeInteger(row.input_tokens),
        cachedInputTokens: nonNegativeInteger(row.cache_read_input_tokens),
        outputTokens: nonNegativeInteger(row.output_tokens),
        reasoningTokens: nonNegativeInteger(row.reasoning_tokens),
        totalTokens: nonNegativeInteger(row.computed_total_tokens),
        durationMs: finiteNonNegativeNumber(row.duration_ms),
        sourceFormat: "zcode-usage-sqlite",
        recordedAtMs: scannedAtMs
      });
      if (isNew) processedUsageNew.push(row);
      health.linesRead += 1;
    };
    for (const [rows, writer, isNew] of [
      [toolRefresh, writeTool, false],
      [toolNew, writeTool, true],
      [usageRefresh, writeUsage, false],
      [usageNew, writeUsage, true]
    ]) {
      for (const row of rows) {
        if (Date.now() >= deadlineMs) {
          deadlineReached = true;
          break;
        }
        writer(row, isNew);
      }
      if (deadlineReached) break;
    }

    const toolBacklog = toolNewCandidates.length > processedToolNew.length
      || toolRefreshCandidates.length > toolRefresh.length
      || (deadlineReached && toolNewCandidates.length + toolRefreshCandidates.length > 0);
    const usageBacklog = usageNewCandidates.length > processedUsageNew.length
      || usageRefreshCandidates.length > usageRefresh.length
      || deadlineReached;
    putProviderCheckpoint(database, {
      provider: "zcode",
      stream: "tool_usage",
      sourceFingerprint,
      ...nextNewBounds(processedToolNew, toolBounds),
      lastScanAtMs: toolRefreshCandidates.length > toolRefresh.length || deadlineReached
        ? toolBounds.lastScanAtMs
        : scannedAtMs
    });
    putProviderCheckpoint(database, {
      provider: "zcode",
      stream: "model_usage",
      sourceFingerprint,
      ...nextNewBounds(processedUsageNew, usageBounds),
      lastScanAtMs: usageRefreshCandidates.length > usageRefresh.length || deadlineReached
        ? usageBounds.lastScanAtMs
        : scannedAtMs
    });
    database.exec("COMMIT");
    health.filesRead = 1;
    health.backlogSources = Number(toolBacklog) + Number(usageBacklog);
    if (health.backlogSources > 0) health.status = "partial";
    if (deadlineReached) health.errorCode = "RUN_DEADLINE_REACHED";
    return health;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    return { ...health, status: "error", errorCode: stableErrorCode(error, "SOURCE_DATABASE_READ_FAILED"), eventsWritten: 0, linesRead: 0 };
  } finally {
    if (source?.isOpen) source.close();
  }
}
