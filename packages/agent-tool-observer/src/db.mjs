import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { classifyTool } from "./core/classify.mjs";
import { ObserverError } from "./errors.mjs";

const SCHEMA_VERSION = "11";

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS source_cursor (
  source_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  file_identity TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL CHECK (offset_bytes >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  discarding_line INTEGER NOT NULL DEFAULT 0 CHECK (discarding_line IN (0, 1)),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS provider_checkpoint (
  provider TEXT NOT NULL CHECK (provider IN ('zcode')),
  stream TEXT NOT NULL CHECK (stream IN ('tool_usage', 'model_usage')),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  last_started_at_ms INTEGER NOT NULL CHECK (last_started_at_ms >= 0),
  last_started_count INTEGER NOT NULL DEFAULT 0 CHECK (last_started_count >= 0),
  last_scan_at_ms INTEGER NOT NULL CHECK (last_scan_at_ms >= 0),
  PRIMARY KEY(provider, stream)
) STRICT;

CREATE TABLE IF NOT EXISTS tool_event (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'zcode')),
  source_id TEXT,
  session_hash TEXT,
  turn_hash TEXT,
  call_hash TEXT,
  session_started_at_ms INTEGER CHECK (session_started_at_ms IS NULL OR session_started_at_ms >= 0),
  occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR occurred_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 256),
  tool_namespace TEXT CHECK (tool_namespace IS NULL OR length(tool_namespace) BETWEEN 1 AND 128),
  route_class TEXT NOT NULL CHECK (route_class IN ('mcp', 'native-shell', 'host-builtin', 'orchestration', 'unknown')),
  is_openadam INTEGER NOT NULL CHECK (is_openadam IN (0, 1)),
  derived INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('observed', 'completed', 'error', 'cancelled', 'unknown')),
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  retry_count INTEGER CHECK (retry_count IS NULL OR retry_count >= 0),
  request_bytes INTEGER CHECK (request_bytes IS NULL OR request_bytes >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 64),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS tool_event_time_idx ON tool_event(occurred_at_ms);
CREATE INDEX IF NOT EXISTS tool_event_tool_idx ON tool_event(tool_name, occurred_at_ms);
CREATE INDEX IF NOT EXISTS tool_event_provider_idx ON tool_event(provider, occurred_at_ms);
CREATE INDEX IF NOT EXISTS tool_event_openadam_idx ON tool_event(is_openadam, occurred_at_ms);
CREATE INDEX IF NOT EXISTS tool_event_turn_idx ON tool_event(provider, turn_hash, occurred_at_ms);

CREATE TABLE IF NOT EXISTS usage_event (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'zcode')),
  session_hash TEXT,
  turn_hash TEXT,
  occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR occurred_at_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 64),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS usage_event_time_idx ON usage_event(occurred_at_ms);
CREATE INDEX IF NOT EXISTS usage_event_provider_idx ON usage_event(provider, occurred_at_ms);
CREATE INDEX IF NOT EXISTS usage_event_turn_idx ON usage_event(provider, turn_hash, occurred_at_ms);

CREATE TABLE IF NOT EXISTS trace_cursor (
  source_id TEXT PRIMARY KEY CHECK (length(source_id) = 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 100),
  file_identity TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL CHECK (offset_bytes >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  discarding_line INTEGER NOT NULL DEFAULT 0 CHECK (discarding_line IN (0, 1)),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS trace_model_step (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 100),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 100),
  source_id TEXT NOT NULL CHECK (length(source_id) = 64),
  session_hash TEXT CHECK (session_hash IS NULL OR length(session_hash) = 64),
  turn_hash TEXT CHECK (turn_hash IS NULL OR length(turn_hash) = 64),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR occurred_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 200),
  query_source TEXT CHECK (query_source IS NULL OR length(query_source) BETWEEN 1 AND 100),
  finish_reason TEXT CHECK (finish_reason IS NULL OR length(finish_reason) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('observed', 'completed', 'error', 'cancelled', 'unknown')),
  attempt INTEGER CHECK (attempt IS NULL OR attempt >= 0),
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  request_bytes INTEGER CHECK (request_bytes IS NULL OR request_bytes >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  request_message_count INTEGER CHECK (request_message_count IS NULL OR request_message_count >= 0),
  offered_tool_count INTEGER CHECK (offered_tool_count IS NULL OR offered_tool_count >= 0),
  emitted_tool_call_count INTEGER CHECK (emitted_tool_call_count IS NULL OR emitted_tool_call_count >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  rationale_present INTEGER CHECK (rationale_present IS NULL OR rationale_present IN (0, 1)),
  stable_error_code TEXT CHECK (stable_error_code IS NULL OR length(stable_error_code) BETWEEN 1 AND 100),
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 100),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS trace_model_step_time_idx ON trace_model_step(occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_model_step_provider_idx ON trace_model_step(provider, occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_model_step_turn_idx ON trace_model_step(provider, turn_hash, occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_model_step_session_idx ON trace_model_step(provider, session_hash, occurred_at_ms);

CREATE TABLE IF NOT EXISTS trace_tool_offer (
  event_id TEXT NOT NULL REFERENCES trace_model_step(event_id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 256),
  tool_namespace TEXT CHECK (tool_namespace IS NULL OR length(tool_namespace) BETWEEN 1 AND 128),
  route_class TEXT NOT NULL CHECK (route_class IN ('mcp', 'native-shell', 'host-builtin', 'orchestration', 'unknown')),
  is_openadam INTEGER NOT NULL CHECK (is_openadam IN (0, 1)),
  PRIMARY KEY(event_id, tool_name)
) STRICT;

CREATE INDEX IF NOT EXISTS trace_tool_offer_name_idx ON trace_tool_offer(tool_name);

CREATE TABLE IF NOT EXISTS trace_tool_event (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 100),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 100),
  source_id TEXT NOT NULL CHECK (length(source_id) = 64),
  session_hash TEXT CHECK (session_hash IS NULL OR length(session_hash) = 64),
  turn_hash TEXT CHECK (turn_hash IS NULL OR length(turn_hash) = 64),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  call_hash TEXT CHECK (call_hash IS NULL OR length(call_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('tool-call', 'tool-result')),
  occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR occurred_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 256),
  tool_namespace TEXT CHECK (tool_namespace IS NULL OR length(tool_namespace) BETWEEN 1 AND 128),
  route_class TEXT NOT NULL CHECK (route_class IN ('mcp', 'native-shell', 'host-builtin', 'orchestration', 'unknown')),
  is_openadam INTEGER NOT NULL CHECK (is_openadam IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('observed', 'completed', 'error', 'cancelled', 'unknown')),
  request_bytes INTEGER CHECK (request_bytes IS NULL OR request_bytes >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  stable_error_code TEXT CHECK (stable_error_code IS NULL OR length(stable_error_code) BETWEEN 1 AND 100),
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 100),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS trace_tool_event_time_idx ON trace_tool_event(occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_tool_event_provider_idx ON trace_tool_event(provider, occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_tool_event_tool_idx ON trace_tool_event(tool_name, occurred_at_ms);
CREATE INDEX IF NOT EXISTS trace_tool_event_session_idx ON trace_tool_event(provider, session_hash, occurred_at_ms);

CREATE TABLE IF NOT EXISTS trace_turn_event (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 100),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 100),
  source_id TEXT NOT NULL CHECK (length(source_id) = 64),
  session_hash TEXT CHECK (session_hash IS NULL OR length(session_hash) = 64),
  turn_hash TEXT CHECK (turn_hash IS NULL OR length(turn_hash) = 64),
  occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR occurred_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'error', 'cancelled', 'unknown')),
  stable_reason TEXT CHECK (stable_reason IS NULL OR length(stable_reason) BETWEEN 1 AND 100),
  stable_error_code TEXT CHECK (stable_error_code IS NULL OR length(stable_error_code) BETWEEN 1 AND 100),
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 100),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS trace_turn_event_time_idx ON trace_turn_event(coalesce(completed_at_ms, occurred_at_ms));
CREATE INDEX IF NOT EXISTS trace_turn_event_provider_idx ON trace_turn_event(provider, coalesce(completed_at_ms, occurred_at_ms));
CREATE INDEX IF NOT EXISTS trace_turn_event_session_idx ON trace_turn_event(provider, session_hash, occurred_at_ms);

CREATE TABLE IF NOT EXISTS trace_adapter_health (
  adapter_id TEXT PRIMARY KEY CHECK (length(adapter_id) BETWEEN 1 AND 100),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  transport TEXT NOT NULL CHECK (transport IN ('public-events', 'opentelemetry', 'official-hooks', 'stable-local-records', 'aggregate-store')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'missing', 'error', 'disabled', 'unconfigured')),
  error_code TEXT,
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 100),
  files_seen INTEGER NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  files_read INTEGER NOT NULL DEFAULT 0 CHECK (files_read >= 0),
  bytes_read INTEGER NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
  lines_read INTEGER NOT NULL DEFAULT 0 CHECK (lines_read >= 0),
  events_written INTEGER NOT NULL DEFAULT 0 CHECK (events_written >= 0),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  backlog_sources INTEGER NOT NULL DEFAULT 0 CHECK (backlog_sources >= 0),
  scanned_at_ms INTEGER NOT NULL CHECK (scanned_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS procedure_event (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  invocation_hash TEXT NOT NULL CHECK (length(invocation_hash) = 64),
  procedure_id TEXT NOT NULL CHECK (length(procedure_id) BETWEEN 1 AND 160),
  procedure_version TEXT NOT NULL CHECK (length(procedure_version) BETWEEN 1 AND 64),
  implementation_id TEXT NOT NULL CHECK (length(implementation_id) BETWEEN 1 AND 160),
  implementation_version TEXT NOT NULL CHECK (length(implementation_version) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'blocked')),
  receipt_outcome TEXT NOT NULL CHECK (receipt_outcome IN ('success', 'error', 'blocked', 'rejected')),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= started_at_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  stage_count INTEGER NOT NULL CHECK (stage_count BETWEEN 1 AND 64),
  error_code TEXT,
  source_format TEXT NOT NULL CHECK (length(source_format) BETWEEN 1 AND 64),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS procedure_event_time_idx ON procedure_event(completed_at_ms);
CREATE INDEX IF NOT EXISTS procedure_event_procedure_idx ON procedure_event(procedure_id, completed_at_ms);

CREATE TABLE IF NOT EXISTS capability_event (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  procedure_event_id TEXT NOT NULL REFERENCES procedure_event(event_id) ON DELETE CASCADE,
  stage_index INTEGER NOT NULL CHECK (stage_index BETWEEN 0 AND 63),
  stage_id TEXT NOT NULL CHECK (length(stage_id) BETWEEN 1 AND 160),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 160),
  capability_version TEXT NOT NULL CHECK (length(capability_version) BETWEEN 1 AND 64),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 160),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 160),
  provider_version TEXT NOT NULL CHECK (length(provider_version) BETWEEN 1 AND 64),
  transport TEXT NOT NULL CHECK (transport IN ('mcp-tool', 'cli', 'library', 'http', 'native-function')),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'skipped')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
  effects TEXT NOT NULL CHECK (length(effects) BETWEEN 2 AND 256),
  error_code TEXT,
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  UNIQUE(procedure_event_id, stage_index)
) STRICT;

CREATE INDEX IF NOT EXISTS capability_event_time_idx ON capability_event(completed_at_ms);
CREATE INDEX IF NOT EXISTS capability_event_capability_idx ON capability_event(capability_id, operation_id, completed_at_ms);
CREATE INDEX IF NOT EXISTS capability_event_target_idx ON capability_event(target);

CREATE TABLE IF NOT EXISTS direct_runtime_cursor (
  source_id TEXT PRIMARY KEY CHECK (length(source_id) = 64),
  file_identity TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL CHECK (offset_bytes >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  discarding_line INTEGER NOT NULL DEFAULT 0 CHECK (discarding_line IN (0, 1)),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS direct_runtime_health (
  source TEXT PRIMARY KEY CHECK (source = 'direct-runtime'),
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'missing', 'error', 'disabled')),
  error_code TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  files_read INTEGER NOT NULL DEFAULT 0 CHECK (files_read >= 0),
  bytes_read INTEGER NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
  lines_read INTEGER NOT NULL DEFAULT 0 CHECK (lines_read >= 0),
  events_written INTEGER NOT NULL DEFAULT 0 CHECK (events_written >= 0),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  backlog_sources INTEGER NOT NULL DEFAULT 0 CHECK (backlog_sources >= 0),
  scanned_at_ms INTEGER NOT NULL CHECK (scanned_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS semantic_execution_event (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 64),
  source_id TEXT NOT NULL CHECK (length(source_id) = 64),
  work_order_hash TEXT NOT NULL CHECK (length(work_order_hash) = 71),
  call_hash TEXT NOT NULL CHECK (length(call_hash) = 71),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= occurred_at_ms),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('capability', 'procedure', 'mcp-tool', 'mcp-operation')),
  semantic_id TEXT CHECK (semantic_id IS NULL OR length(semantic_id) BETWEEN 1 AND 200),
  semantic_version TEXT CHECK (semantic_version IS NULL OR length(semantic_version) BETWEEN 1 AND 100),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 200),
  tool_name TEXT CHECK (tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 200),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  provider_version TEXT CHECK (provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 100),
  transport TEXT NOT NULL CHECK (transport IN ('capability-jsonl-v0.1', 'procedure-jsonl-v0.2', 'mcp-stdio')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('persistent', 'per-call')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'provider_error', 'host_error')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 160),
  duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
  queue_ms REAL CHECK (queue_ms IS NULL OR queue_ms >= 0),
  provider_round_trip_ms REAL CHECK (provider_round_trip_ms IS NULL OR provider_round_trip_ms >= 0),
  request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  session_state TEXT CHECK (session_state IS NULL OR session_state IN ('cold', 'warm')),
  binding_digest TEXT CHECK (binding_digest IS NULL OR length(binding_digest) = 71),
  contract_digest TEXT CHECK (contract_digest IS NULL OR length(contract_digest) = 71),
  source_format TEXT NOT NULL CHECK (source_format = 'openadam.direct-execution-observation.v0.1'),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS semantic_execution_time_idx ON semantic_execution_event(completed_at_ms);
CREATE INDEX IF NOT EXISTS semantic_execution_target_idx ON semantic_execution_event(target_kind, semantic_id, operation_id, completed_at_ms);
CREATE INDEX IF NOT EXISTS semantic_execution_provider_idx ON semantic_execution_event(provider_id, completed_at_ms);

CREATE TABLE IF NOT EXISTS context_surface_measurement (
  measurement_id TEXT PRIMARY KEY CHECK (length(measurement_id) = 64),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_revision TEXT NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 200),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
  catalog_sha256 TEXT NOT NULL CHECK (length(catalog_sha256) = 64),
  catalog_bytes INTEGER NOT NULL CHECK (catalog_bytes >= 0),
  largest_tool_bytes INTEGER NOT NULL CHECK (largest_tool_bytes >= 0),
  tool_count INTEGER NOT NULL CHECK (tool_count >= 0),
  schema_count INTEGER NOT NULL CHECK (schema_count >= 0),
  described_tool_count INTEGER NOT NULL CHECK (described_tool_count >= 0),
  duplicate_schema_count INTEGER NOT NULL CHECK (duplicate_schema_count >= 0),
  hard_name_collision_count INTEGER NOT NULL CHECK (hard_name_collision_count >= 0),
  token_measurements_json TEXT NOT NULL CHECK (length(token_measurements_json) BETWEEN 2 AND 65536),
  source_format TEXT NOT NULL CHECK (source_format = 'context-surface.analysis.v0.1'),
  imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS context_surface_source_idx ON context_surface_measurement(source_id, imported_at_ms);

CREATE TABLE IF NOT EXISTS agent_host_deployment_observation (
  deployment_id TEXT PRIMARY KEY CHECK (length(deployment_id) = 64),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  activated_at_ms INTEGER NOT NULL CHECK (activated_at_ms >= 0),
  channel TEXT NOT NULL CHECK (channel IN ('release', 'development')),
  release_id TEXT CHECK (release_id IS NULL OR length(release_id) BETWEEN 1 AND 200),
  suite_version TEXT NOT NULL CHECK (length(suite_version) BETWEEN 1 AND 100),
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 100),
  components_json TEXT NOT NULL CHECK (length(components_json) BETWEEN 2 AND 131072),
  context_source_id TEXT CHECK (context_source_id IS NULL OR length(context_source_id) BETWEEN 1 AND 200),
  context_source_revision TEXT CHECK (context_source_revision IS NULL OR length(context_source_revision) BETWEEN 1 AND 200),
  context_catalog_sha256 TEXT CHECK (context_catalog_sha256 IS NULL OR length(context_catalog_sha256) = 64),
  context_catalog_bytes INTEGER CHECK (context_catalog_bytes IS NULL OR context_catalog_bytes >= 0),
  context_tool_count INTEGER CHECK (context_tool_count IS NULL OR context_tool_count >= 0),
  source_format TEXT NOT NULL CHECK (source_format = 'openadam.agent-host-deployment-observation.v0.1')
) STRICT;

CREATE INDEX IF NOT EXISTS agent_host_deployment_time_idx
ON agent_host_deployment_observation(activated_at_ms, observed_at_ms);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY CHECK (provider IN ('codex', 'claude', 'zcode')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'missing', 'error', 'disabled')),
  error_code TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  files_read INTEGER NOT NULL DEFAULT 0 CHECK (files_read >= 0),
  bytes_read INTEGER NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
  lines_read INTEGER NOT NULL DEFAULT 0 CHECK (lines_read >= 0),
  events_written INTEGER NOT NULL DEFAULT 0 CHECK (events_written >= 0),
  skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK (skipped_lines >= 0),
  backlog_sources INTEGER NOT NULL DEFAULT 0 CHECK (backlog_sources >= 0),
  scanned_at_ms INTEGER NOT NULL CHECK (scanned_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS collection_run (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'skipped', 'error')),
  providers_ok INTEGER NOT NULL DEFAULT 0 CHECK (providers_ok >= 0),
  providers_partial INTEGER NOT NULL DEFAULT 0 CHECK (providers_partial >= 0),
  providers_missing INTEGER NOT NULL DEFAULT 0 CHECK (providers_missing >= 0),
  providers_error INTEGER NOT NULL DEFAULT 0 CHECK (providers_error >= 0),
  events_written INTEGER NOT NULL DEFAULT 0 CHECK (events_written >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS collector_lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0)
) STRICT;
`;

function ensureOwnerDirectory(directory) {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObserverError("STATE_DIR_INVALID", "Observer state directory must be a real directory");
  }
  if (!existed) fs.chmodSync(directory, 0o700);
  if ((stat.mode & 0o077) !== 0) {
    throw new ObserverError("STATE_DIR_PERMISSIONS", "Observer state directory must not be accessible by group or other users");
  }
}

function reclassifyStoredTools(database) {
  const update = database.prepare(`
    UPDATE tool_event
    SET tool_namespace = ?, route_class = ?, is_openadam = ?
    WHERE event_id = ?
  `);
  for (const row of database.prepare("SELECT event_id, tool_name FROM tool_event").all()) {
    const classified = classifyTool(row.tool_name);
    update.run(classified.namespace, classified.routeClass, classified.isOpenAdam ? 1 : 0, row.event_id);
  }
}

function migrateSemanticExecutionTargets(database) {
  const table = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'semantic_execution_event'
  `).get();
  if (table === undefined || table.sql.includes("'mcp-operation'")) return;

  database.exec(`
    DROP INDEX IF EXISTS semantic_execution_time_idx;
    DROP INDEX IF EXISTS semantic_execution_target_idx;
    DROP INDEX IF EXISTS semantic_execution_provider_idx;
    ALTER TABLE semantic_execution_event RENAME TO semantic_execution_event_legacy;
  `);
  database.exec(SCHEMA_SQL);
  database.exec(`
    INSERT INTO semantic_execution_event(
      event_id, source_id, work_order_hash, call_hash, occurred_at_ms,
      completed_at_ms, target_kind, semantic_id, semantic_version,
      operation_id, tool_name, provider_id, provider_version, transport,
      lifecycle, status, error_code, duration_ms, queue_ms,
      provider_round_trip_ms, request_bytes, response_bytes, session_state,
      binding_digest, contract_digest, source_format, recorded_at_ms
    )
    SELECT
      event_id, source_id, work_order_hash, call_hash, occurred_at_ms,
      completed_at_ms, target_kind, semantic_id, semantic_version,
      operation_id, tool_name, provider_id, provider_version, transport,
      lifecycle, status, error_code, duration_ms, queue_ms,
      provider_round_trip_ms, request_bytes, response_bytes, session_state,
      binding_digest, contract_digest, source_format, recorded_at_ms
    FROM semantic_execution_event_legacy;
    DROP TABLE semantic_execution_event_legacy;
  `);
}

function ensureAdditiveToolColumns(database) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(tool_event)").all().map((row) => row.name)
  );
  if (!columns.has("session_started_at_ms")) {
    database.exec(`
      ALTER TABLE tool_event
      ADD COLUMN session_started_at_ms INTEGER
      CHECK (session_started_at_ms IS NULL OR session_started_at_ms >= 0)
    `);
  }
}

export function openStateDatabase(config) {
  ensureOwnerDirectory(config.stateDir);
  ensureOwnerDirectory(config.logsDir);
  const databaseExisted = fs.existsSync(config.databasePath);
  for (const candidate of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ObserverError("STATE_FILE_INVALID", "Observer state files must be regular non-symlinked files");
    }
  }
  const database = new DatabaseSync(config.databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  database.exec(SCHEMA_SQL);
  const storedVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value;
  if (storedVersion === undefined) {
    database.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  } else if (["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].includes(storedVersion)) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (storedVersion === "8") {
        // The portable human-checkpoint machinery was removed from the
        // standards on 2026-08-23; legacy v0.2 checkpoint fields are now
        // read-and-discard, so the persisted approval-state table is dropped.
        database.exec("DROP TABLE IF EXISTS human_checkpoint_event");
      }
      const checkpointColumns = new Set(
        database.prepare("PRAGMA table_info(provider_checkpoint)").all().map((row) => row.name)
      );
      if (!checkpointColumns.has("last_started_count")) {
        database.exec(`
          ALTER TABLE provider_checkpoint
          ADD COLUMN last_started_count INTEGER NOT NULL DEFAULT 0 CHECK (last_started_count >= 0)
        `);
      }
      const procedureColumns = new Set(
        database.prepare("PRAGMA table_info(procedure_event)").all().map((row) => row.name)
      );
      if (!procedureColumns.has("receipt_outcome")) {
        database.exec(`
          ALTER TABLE procedure_event
          ADD COLUMN receipt_outcome TEXT
          CHECK (receipt_outcome IS NULL OR receipt_outcome IN ('success', 'error', 'blocked', 'rejected'))
        `);
        database.prepare("UPDATE procedure_event SET receipt_outcome = outcome").run();
      }
      const toolColumns = new Set(
        database.prepare("PRAGMA table_info(tool_event)").all().map((row) => row.name)
      );
      if (!toolColumns.has("request_bytes")) {
        database.exec(`
          ALTER TABLE tool_event
          ADD COLUMN request_bytes INTEGER CHECK (request_bytes IS NULL OR request_bytes >= 0);
          ALTER TABLE tool_event
          ADD COLUMN response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0);
        `);
      }
      if (["1", "2", "3"].includes(storedVersion)) {
        database.prepare("DELETE FROM tool_event WHERE provider = 'codex'").run();
        database.prepare("DELETE FROM usage_event WHERE provider = 'codex'").run();
        database.prepare("DELETE FROM source_cursor WHERE provider = 'codex'").run();
      }
      reclassifyStoredTools(database);
      migrateSemanticExecutionTargets(database);
      database.exec(SCHEMA_SQL);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  } else if (storedVersion === "12") {
    // The deployment-observation table is purely additive and older v11
    // readers safely ignore it. An early dogfood candidate unnecessarily
    // promoted the metadata version; normalize it so rollback keeps working.
    database.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
  } else if (storedVersion !== SCHEMA_VERSION) {
    database.close();
    throw new ObserverError("SCHEMA_VERSION_UNSUPPORTED", "Observer database schema version is not supported");
  }
  ensureAdditiveToolColumns(database);
  if (!databaseExisted) fs.chmodSync(config.databasePath, 0o600);
  const databaseMode = fs.lstatSync(config.databasePath).mode;
  if ((databaseMode & 0o077) !== 0) {
    database.close();
    throw new ObserverError("STATE_FILE_PERMISSIONS", "Observer database must not be accessible by group or other users");
  }
  for (const suffix of ["-wal", "-shm"]) {
    const candidate = `${config.databasePath}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    if (!databaseExisted) fs.chmodSync(candidate, 0o600);
    if ((fs.lstatSync(candidate).mode & 0o077) !== 0) {
      database.close();
      throw new ObserverError("STATE_FILE_PERMISSIONS", "Observer database sidecars must not be accessible by group or other users");
    }
  }
  return database;
}

export function openReadOnlyStateDatabase(config) {
  if (!fs.existsSync(config.databasePath)) {
    throw new ObserverError("STATE_DATABASE_MISSING", "Observer database does not exist yet");
  }
  const stat = fs.lstatSync(config.databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new ObserverError("STATE_FILE_INVALID", "Observer database must be an owner-only regular non-symlinked file");
  }
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
  return database;
}

export function closeDatabase(database) {
  if (database?.isOpen) database.close();
}

export function getCursor(database, sourceId) {
  return database.prepare("SELECT * FROM source_cursor WHERE source_id = ?").get(sourceId) ?? null;
}

export function getTraceCursor(database, sourceId) {
  return database.prepare("SELECT * FROM trace_cursor WHERE source_id = ?").get(sourceId) ?? null;
}

export function putTraceCursor(database, cursor) {
  database.prepare(`
    INSERT INTO trace_cursor(
      source_id, adapter_id, file_identity, offset_bytes, size_bytes, mtime_ms,
      discarding_line, skipped_lines, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      adapter_id = excluded.adapter_id,
      file_identity = excluded.file_identity,
      offset_bytes = excluded.offset_bytes,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      discarding_line = excluded.discarding_line,
      skipped_lines = trace_cursor.skipped_lines + excluded.skipped_lines,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    cursor.sourceId,
    cursor.adapterId,
    cursor.fileIdentity,
    cursor.offsetBytes,
    cursor.sizeBytes,
    Math.max(0, Math.round(cursor.mtimeMs)),
    cursor.discardingLine ? 1 : 0,
    cursor.skippedLines,
    cursor.updatedAtMs
  );
}

export function putTraceModelStep(database, step) {
  const result = database.prepare(`
    INSERT INTO trace_model_step(
      event_id, provider, adapter_id, adapter_version, provider_version,
      source_id, session_hash, turn_hash, request_hash, occurred_at_ms,
      completed_at_ms, model_id, query_source, finish_reason, status, attempt,
      duration_ms, request_bytes, response_bytes, request_message_count,
      offered_tool_count, emitted_tool_call_count, input_tokens,
      cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
      rationale_present, stable_error_code, source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      completed_at_ms = COALESCE(excluded.completed_at_ms, trace_model_step.completed_at_ms),
      finish_reason = COALESCE(excluded.finish_reason, trace_model_step.finish_reason),
      status = CASE WHEN excluded.status != 'observed' THEN excluded.status ELSE trace_model_step.status END,
      duration_ms = COALESCE(excluded.duration_ms, trace_model_step.duration_ms),
      response_bytes = COALESCE(excluded.response_bytes, trace_model_step.response_bytes),
      emitted_tool_call_count = COALESCE(excluded.emitted_tool_call_count, trace_model_step.emitted_tool_call_count),
      input_tokens = COALESCE(excluded.input_tokens, trace_model_step.input_tokens),
      cached_input_tokens = COALESCE(excluded.cached_input_tokens, trace_model_step.cached_input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, trace_model_step.output_tokens),
      reasoning_tokens = COALESCE(excluded.reasoning_tokens, trace_model_step.reasoning_tokens),
      total_tokens = COALESCE(excluded.total_tokens, trace_model_step.total_tokens),
      rationale_present = COALESCE(excluded.rationale_present, trace_model_step.rationale_present),
      stable_error_code = COALESCE(excluded.stable_error_code, trace_model_step.stable_error_code),
      recorded_at_ms = excluded.recorded_at_ms
    WHERE
      (excluded.completed_at_ms IS NOT NULL AND excluded.completed_at_ms IS NOT trace_model_step.completed_at_ms)
      OR (excluded.finish_reason IS NOT NULL AND excluded.finish_reason IS NOT trace_model_step.finish_reason)
      OR (excluded.status != 'observed' AND excluded.status IS NOT trace_model_step.status)
      OR (excluded.duration_ms IS NOT NULL AND excluded.duration_ms IS NOT trace_model_step.duration_ms)
      OR (excluded.response_bytes IS NOT NULL AND excluded.response_bytes IS NOT trace_model_step.response_bytes)
      OR (excluded.emitted_tool_call_count IS NOT NULL AND excluded.emitted_tool_call_count IS NOT trace_model_step.emitted_tool_call_count)
      OR (excluded.input_tokens IS NOT NULL AND excluded.input_tokens IS NOT trace_model_step.input_tokens)
      OR (excluded.cached_input_tokens IS NOT NULL AND excluded.cached_input_tokens IS NOT trace_model_step.cached_input_tokens)
      OR (excluded.output_tokens IS NOT NULL AND excluded.output_tokens IS NOT trace_model_step.output_tokens)
      OR (excluded.reasoning_tokens IS NOT NULL AND excluded.reasoning_tokens IS NOT trace_model_step.reasoning_tokens)
      OR (excluded.total_tokens IS NOT NULL AND excluded.total_tokens IS NOT trace_model_step.total_tokens)
      OR (excluded.rationale_present IS NOT NULL AND excluded.rationale_present IS NOT trace_model_step.rationale_present)
      OR (excluded.stable_error_code IS NOT NULL AND excluded.stable_error_code IS NOT trace_model_step.stable_error_code)
  `).run(
    step.eventId, step.provider, step.adapterId, step.adapterVersion,
    step.providerVersion ?? null, step.sourceId, step.sessionHash ?? null,
    step.turnHash ?? null, step.requestHash ?? null, step.occurredAtMs ?? null,
    step.completedAtMs ?? null, step.modelId ?? null, step.querySource ?? null,
    step.finishReason ?? null, step.status, step.attempt ?? null,
    step.durationMs ?? null, step.requestBytes ?? null, step.responseBytes ?? null,
    step.requestMessageCount ?? null, step.offeredToolCount ?? null,
    step.emittedToolCallCount ?? null, step.inputTokens ?? null,
    step.cachedInputTokens ?? null, step.outputTokens ?? null,
    step.reasoningTokens ?? null, step.totalTokens ?? null,
    step.rationalePresent === null || step.rationalePresent === undefined ? null : Number(step.rationalePresent),
    step.stableErrorCode ?? null, step.sourceFormat, step.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putTraceToolOffer(database, offer) {
  const classified = classifyTool(offer.toolName);
  const result = database.prepare(`
    INSERT INTO trace_tool_offer(
      event_id, tool_name, tool_namespace, route_class, is_openadam
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id, tool_name) DO NOTHING
  `).run(
    offer.eventId,
    classified.toolName,
    classified.namespace,
    classified.routeClass,
    classified.isOpenAdam ? 1 : 0
  );
  return result.changes > 0 ? 1 : 0;
}

export function putTraceToolEvent(database, event) {
  const classified = classifyTool(event.toolName);
  const result = database.prepare(`
    INSERT INTO trace_tool_event(
      event_id, provider, adapter_id, adapter_version, provider_version,
      source_id, session_hash, turn_hash, request_hash, call_hash, kind,
      occurred_at_ms, completed_at_ms, tool_name, tool_namespace, route_class,
      is_openadam, status, request_bytes, response_bytes, stable_error_code,
      source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      completed_at_ms = COALESCE(excluded.completed_at_ms, trace_tool_event.completed_at_ms),
      status = CASE WHEN excluded.status != 'observed' THEN excluded.status ELSE trace_tool_event.status END,
      response_bytes = COALESCE(excluded.response_bytes, trace_tool_event.response_bytes),
      stable_error_code = COALESCE(excluded.stable_error_code, trace_tool_event.stable_error_code),
      recorded_at_ms = excluded.recorded_at_ms
    WHERE
      (excluded.completed_at_ms IS NOT NULL AND excluded.completed_at_ms IS NOT trace_tool_event.completed_at_ms)
      OR (excluded.status != 'observed' AND excluded.status IS NOT trace_tool_event.status)
      OR (excluded.response_bytes IS NOT NULL AND excluded.response_bytes IS NOT trace_tool_event.response_bytes)
      OR (excluded.stable_error_code IS NOT NULL AND excluded.stable_error_code IS NOT trace_tool_event.stable_error_code)
  `).run(
    event.eventId, event.provider, event.adapterId, event.adapterVersion,
    event.providerVersion ?? null, event.sourceId, event.sessionHash ?? null,
    event.turnHash ?? null, event.requestHash ?? null, event.callHash ?? null,
    event.kind, event.occurredAtMs ?? null, event.completedAtMs ?? null,
    classified.toolName, classified.namespace, classified.routeClass,
    classified.isOpenAdam ? 1 : 0, event.status, event.requestBytes ?? null,
    event.responseBytes ?? null, event.stableErrorCode ?? null,
    event.sourceFormat, event.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putTraceTurnEvent(database, event) {
  const result = database.prepare(`
    INSERT INTO trace_turn_event(
      event_id, provider, adapter_id, adapter_version, provider_version,
      source_id, session_hash, turn_hash, occurred_at_ms, completed_at_ms,
      status, stable_reason, stable_error_code, source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      completed_at_ms = COALESCE(excluded.completed_at_ms, trace_turn_event.completed_at_ms),
      status = excluded.status,
      stable_reason = COALESCE(excluded.stable_reason, trace_turn_event.stable_reason),
      stable_error_code = COALESCE(excluded.stable_error_code, trace_turn_event.stable_error_code),
      recorded_at_ms = excluded.recorded_at_ms
    WHERE
      (excluded.completed_at_ms IS NOT NULL AND excluded.completed_at_ms IS NOT trace_turn_event.completed_at_ms)
      OR excluded.status IS NOT trace_turn_event.status
      OR (excluded.stable_reason IS NOT NULL AND excluded.stable_reason IS NOT trace_turn_event.stable_reason)
      OR (excluded.stable_error_code IS NOT NULL AND excluded.stable_error_code IS NOT trace_turn_event.stable_error_code)
  `).run(
    event.eventId, event.provider, event.adapterId, event.adapterVersion,
    event.providerVersion ?? null, event.sourceId, event.sessionHash ?? null,
    event.turnHash ?? null, event.occurredAtMs ?? null,
    event.completedAtMs ?? null, event.status, event.stableReason ?? null,
    event.stableErrorCode ?? null, event.sourceFormat, event.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putTraceAdapterHealth(database, health) {
  database.prepare(`
    INSERT INTO trace_adapter_health(
      adapter_id, provider, transport, status, error_code, provider_version,
      files_seen, files_read, bytes_read, lines_read, events_written,
      skipped_lines, backlog_sources, scanned_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(adapter_id) DO UPDATE SET
      provider = excluded.provider,
      transport = excluded.transport,
      status = excluded.status,
      error_code = excluded.error_code,
      provider_version = excluded.provider_version,
      files_seen = excluded.files_seen,
      files_read = excluded.files_read,
      bytes_read = excluded.bytes_read,
      lines_read = excluded.lines_read,
      events_written = excluded.events_written,
      skipped_lines = excluded.skipped_lines,
      backlog_sources = excluded.backlog_sources,
      scanned_at_ms = excluded.scanned_at_ms
  `).run(
    health.adapterId, health.provider, health.transport, health.status,
    health.errorCode ?? null, health.providerVersion ?? null,
    health.filesSeen ?? 0, health.filesRead ?? 0, health.bytesRead ?? 0,
    health.linesRead ?? 0, health.eventsWritten ?? 0, health.skippedLines ?? 0,
    health.backlogSources ?? 0, health.scannedAtMs
  );
}

export function putCursor(database, cursor) {
  database.prepare(`
    INSERT INTO source_cursor(
      source_id, provider, file_identity, offset_bytes, size_bytes, mtime_ms,
      discarding_line, skipped_lines, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      provider = excluded.provider,
      file_identity = excluded.file_identity,
      offset_bytes = excluded.offset_bytes,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      discarding_line = excluded.discarding_line,
      skipped_lines = source_cursor.skipped_lines + excluded.skipped_lines,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    cursor.sourceId,
    cursor.provider,
    cursor.fileIdentity,
    cursor.offsetBytes,
    cursor.sizeBytes,
    Math.max(0, Math.round(cursor.mtimeMs)),
    cursor.discardingLine ? 1 : 0,
    cursor.skippedLines,
    cursor.updatedAtMs
  );
}

export function getProviderCheckpoint(database, provider, stream, sourceFingerprint) {
  const checkpoint = database.prepare(`
    SELECT last_started_at_ms, last_started_count, last_scan_at_ms
    FROM provider_checkpoint
    WHERE provider = ? AND stream = ? AND source_fingerprint = ?
  `).get(provider, stream, sourceFingerprint);
  return checkpoint ? {
    lastStartedAtMs: Number(checkpoint.last_started_at_ms),
    lastStartedCount: Number(checkpoint.last_started_count),
    lastScanAtMs: Number(checkpoint.last_scan_at_ms)
  } : null;
}

export function putProviderCheckpoint(database, checkpoint) {
  database.prepare(`
    INSERT INTO provider_checkpoint(
      provider, stream, source_fingerprint, last_started_at_ms,
      last_started_count, last_scan_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, stream) DO UPDATE SET
      source_fingerprint = excluded.source_fingerprint,
      last_started_at_ms = excluded.last_started_at_ms,
      last_started_count = excluded.last_started_count,
      last_scan_at_ms = excluded.last_scan_at_ms
  `).run(
    checkpoint.provider,
    checkpoint.stream,
    checkpoint.sourceFingerprint,
    checkpoint.lastStartedAtMs,
    checkpoint.lastStartedCount,
    checkpoint.lastScanAtMs
  );
}

export function putToolEvent(database, event) {
  const result = database.prepare(`
    INSERT INTO tool_event(
      event_id, provider, source_id, session_hash, turn_hash, call_hash, session_started_at_ms,
      occurred_at_ms, completed_at_ms, tool_name, tool_namespace, route_class,
      is_openadam, derived, status, duration_ms, retry_count, request_bytes,
      response_bytes, source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      tool_namespace = excluded.tool_namespace,
      route_class = excluded.route_class,
      is_openadam = excluded.is_openadam,
      session_started_at_ms = CASE
        WHEN tool_event.session_started_at_ms IS NULL THEN excluded.session_started_at_ms
        WHEN excluded.session_started_at_ms IS NULL THEN tool_event.session_started_at_ms
        ELSE min(tool_event.session_started_at_ms, excluded.session_started_at_ms)
      END,
      completed_at_ms = COALESCE(excluded.completed_at_ms, tool_event.completed_at_ms),
      status = CASE
        WHEN excluded.status IN ('completed', 'error', 'cancelled') THEN excluded.status
        ELSE tool_event.status
      END,
      duration_ms = COALESCE(excluded.duration_ms, tool_event.duration_ms),
      retry_count = COALESCE(excluded.retry_count, tool_event.retry_count),
      request_bytes = COALESCE(excluded.request_bytes, tool_event.request_bytes),
      response_bytes = COALESCE(excluded.response_bytes, tool_event.response_bytes),
      recorded_at_ms = excluded.recorded_at_ms
    WHERE
      excluded.tool_namespace IS NOT tool_event.tool_namespace
      OR excluded.route_class IS NOT tool_event.route_class
      OR excluded.is_openadam IS NOT tool_event.is_openadam
      OR (excluded.session_started_at_ms IS NOT NULL AND (
        tool_event.session_started_at_ms IS NULL
        OR excluded.session_started_at_ms < tool_event.session_started_at_ms
      ))
      OR (excluded.completed_at_ms IS NOT NULL AND excluded.completed_at_ms IS NOT tool_event.completed_at_ms)
      OR (excluded.status IN ('completed', 'error', 'cancelled') AND excluded.status IS NOT tool_event.status)
      OR (excluded.duration_ms IS NOT NULL AND excluded.duration_ms IS NOT tool_event.duration_ms)
      OR (excluded.retry_count IS NOT NULL AND excluded.retry_count IS NOT tool_event.retry_count)
      OR (excluded.request_bytes IS NOT NULL AND excluded.request_bytes IS NOT tool_event.request_bytes)
      OR (excluded.response_bytes IS NOT NULL AND excluded.response_bytes IS NOT tool_event.response_bytes)
  `).run(
    event.eventId,
    event.provider,
    event.sourceId ?? null,
    event.sessionHash ?? null,
    event.turnHash ?? null,
    event.callHash ?? null,
    event.sessionStartedAtMs ?? null,
    event.occurredAtMs ?? null,
    event.completedAtMs ?? null,
    event.toolName,
    event.toolNamespace ?? null,
    event.routeClass,
    event.isOpenAdam ? 1 : 0,
    event.derived ? 1 : 0,
    event.status,
    event.durationMs ?? null,
    event.retryCount ?? null,
    event.requestBytes ?? null,
    event.responseBytes ?? null,
    event.sourceFormat,
    event.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function applySessionStartObservation(database, provider, sessionHash, sessionStartedAtMs) {
  if (sessionHash === null || sessionHash === undefined || sessionStartedAtMs === null || sessionStartedAtMs === undefined) return 0;
  const result = database.prepare(`
    UPDATE tool_event
    SET session_started_at_ms = ?
    WHERE provider = ?
      AND session_hash = ?
      AND (session_started_at_ms IS NULL OR session_started_at_ms > ?)
  `).run(sessionStartedAtMs, provider, sessionHash, sessionStartedAtMs);
  return Number(result.changes);
}

export function completeToolEvent(database, eventId, status, completedAtMs, responseBytes = null) {
  const result = database.prepare(`
    UPDATE tool_event SET
      completed_at_ms = ?,
      status = ?,
      duration_ms = CASE
        WHEN occurred_at_ms IS NOT NULL AND ? >= occurred_at_ms THEN ? - occurred_at_ms
        ELSE duration_ms
      END,
      response_bytes = COALESCE(?, response_bytes),
      recorded_at_ms = ?
    WHERE event_id = ? AND (
      completed_at_ms IS NOT ? OR status IS NOT ?
      OR (? IS NOT NULL AND response_bytes IS NOT ?)
    )
  `).run(
    completedAtMs, status, completedAtMs, completedAtMs, responseBytes,
    Date.now(), eventId, completedAtMs, status, responseBytes, responseBytes
  );
  return result.changes > 0 ? 1 : 0;
}

export function getDirectRuntimeCursor(database, sourceId) {
  return database.prepare("SELECT * FROM direct_runtime_cursor WHERE source_id = ?").get(sourceId) ?? null;
}

export function putDirectRuntimeCursor(database, cursor) {
  database.prepare(`
    INSERT INTO direct_runtime_cursor(
      source_id, file_identity, offset_bytes, size_bytes, mtime_ms,
      discarding_line, skipped_lines, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      file_identity = excluded.file_identity,
      offset_bytes = excluded.offset_bytes,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      discarding_line = excluded.discarding_line,
      skipped_lines = direct_runtime_cursor.skipped_lines + excluded.skipped_lines,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    cursor.sourceId,
    cursor.fileIdentity,
    cursor.offsetBytes,
    cursor.sizeBytes,
    Math.max(0, Math.round(cursor.mtimeMs)),
    cursor.discardingLine ? 1 : 0,
    cursor.skippedLines,
    cursor.updatedAtMs
  );
}

export function putDirectRuntimeHealth(database, health) {
  database.prepare(`
    INSERT INTO direct_runtime_health(
      source, status, error_code, files_seen, files_read, bytes_read,
      lines_read, events_written, skipped_lines, backlog_sources, scanned_at_ms
    ) VALUES ('direct-runtime', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      status = excluded.status,
      error_code = excluded.error_code,
      files_seen = excluded.files_seen,
      files_read = excluded.files_read,
      bytes_read = excluded.bytes_read,
      lines_read = excluded.lines_read,
      events_written = excluded.events_written,
      skipped_lines = excluded.skipped_lines,
      backlog_sources = excluded.backlog_sources,
      scanned_at_ms = excluded.scanned_at_ms
  `).run(
    health.status,
    health.errorCode ?? null,
    health.filesSeen ?? 0,
    health.filesRead ?? 0,
    health.bytesRead ?? 0,
    health.linesRead ?? 0,
    health.eventsWritten ?? 0,
    health.skippedLines ?? 0,
    health.backlogSources ?? 0,
    health.scannedAtMs
  );
}

export function putSemanticExecutionEvent(database, event) {
  const result = database.prepare(`
    INSERT INTO semantic_execution_event(
      event_id, source_id, work_order_hash, call_hash, occurred_at_ms,
      completed_at_ms, target_kind, semantic_id, semantic_version,
      operation_id, tool_name, provider_id, provider_version, transport,
      lifecycle, status, error_code, duration_ms, queue_ms,
      provider_round_trip_ms, request_bytes, response_bytes, session_state,
      binding_digest, contract_digest, source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    event.eventId,
    event.sourceId,
    event.workOrderHash,
    event.callHash,
    event.occurredAtMs,
    event.completedAtMs,
    event.targetKind,
    event.semanticId ?? null,
    event.semanticVersion ?? null,
    event.operationId ?? null,
    event.toolName ?? null,
    event.providerId,
    event.providerVersion ?? null,
    event.transport,
    event.lifecycle,
    event.status,
    event.errorCode ?? null,
    event.durationMs,
    event.queueMs ?? null,
    event.providerRoundTripMs ?? null,
    event.requestBytes,
    event.responseBytes ?? null,
    event.sessionState ?? null,
    event.bindingDigest ?? null,
    event.contractDigest ?? null,
    event.sourceFormat,
    event.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putContextSurfaceMeasurement(database, measurement) {
  const result = database.prepare(`
    INSERT INTO context_surface_measurement(
      measurement_id, source_id, source_revision, snapshot_sha256,
      snapshot_bytes, catalog_sha256, catalog_bytes, largest_tool_bytes,
      tool_count, schema_count, described_tool_count, duplicate_schema_count,
      hard_name_collision_count, token_measurements_json, source_format,
      imported_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(measurement_id) DO NOTHING
  `).run(
    measurement.measurementId,
    measurement.sourceId,
    measurement.sourceRevision,
    measurement.snapshotSha256,
    measurement.snapshotBytes,
    measurement.catalogSha256,
    measurement.catalogBytes,
    measurement.largestToolBytes,
    measurement.toolCount,
    measurement.schemaCount,
    measurement.describedToolCount,
    measurement.duplicateSchemaCount,
    measurement.hardNameCollisionCount,
    JSON.stringify(measurement.tokenMeasurements),
    measurement.sourceFormat,
    measurement.importedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putAgentHostDeploymentObservation(database, deployment) {
  const context = deployment.context ?? {};
  const result = database.prepare(`
    INSERT INTO agent_host_deployment_observation(
      deployment_id, observed_at_ms, activated_at_ms, channel, release_id,
      suite_version, profile, components_json, context_source_id,
      context_source_revision, context_catalog_sha256, context_catalog_bytes,
      context_tool_count, source_format
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deployment_id) DO UPDATE SET
      observed_at_ms = max(agent_host_deployment_observation.observed_at_ms, excluded.observed_at_ms)
    WHERE excluded.observed_at_ms > agent_host_deployment_observation.observed_at_ms
  `).run(
    deployment.deploymentId,
    deployment.observedAtMs,
    deployment.activatedAtMs,
    deployment.channel,
    deployment.releaseId ?? null,
    deployment.suiteVersion,
    deployment.profile,
    JSON.stringify(deployment.components),
    context.sourceId ?? null,
    context.sourceRevision ?? null,
    context.catalogSha256 ?? null,
    context.catalogBytes ?? null,
    context.toolCount ?? null,
    deployment.sourceFormat
  );
  return result.changes > 0 ? 1 : 0;
}

export function putUsageEvent(database, event) {
  const result = database.prepare(`
    INSERT INTO usage_event(
      event_id, provider, session_hash, turn_hash, occurred_at_ms, input_tokens,
      cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
      duration_ms, source_format, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      occurred_at_ms = COALESCE(excluded.occurred_at_ms, usage_event.occurred_at_ms),
      input_tokens = COALESCE(excluded.input_tokens, usage_event.input_tokens),
      cached_input_tokens = COALESCE(excluded.cached_input_tokens, usage_event.cached_input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, usage_event.output_tokens),
      reasoning_tokens = COALESCE(excluded.reasoning_tokens, usage_event.reasoning_tokens),
      total_tokens = COALESCE(excluded.total_tokens, usage_event.total_tokens),
      duration_ms = COALESCE(excluded.duration_ms, usage_event.duration_ms),
      recorded_at_ms = excluded.recorded_at_ms
    WHERE
      (excluded.occurred_at_ms IS NOT NULL AND excluded.occurred_at_ms IS NOT usage_event.occurred_at_ms)
      OR (excluded.input_tokens IS NOT NULL AND excluded.input_tokens IS NOT usage_event.input_tokens)
      OR (excluded.cached_input_tokens IS NOT NULL AND excluded.cached_input_tokens IS NOT usage_event.cached_input_tokens)
      OR (excluded.output_tokens IS NOT NULL AND excluded.output_tokens IS NOT usage_event.output_tokens)
      OR (excluded.reasoning_tokens IS NOT NULL AND excluded.reasoning_tokens IS NOT usage_event.reasoning_tokens)
      OR (excluded.total_tokens IS NOT NULL AND excluded.total_tokens IS NOT usage_event.total_tokens)
      OR (excluded.duration_ms IS NOT NULL AND excluded.duration_ms IS NOT usage_event.duration_ms)
  `).run(
    event.eventId,
    event.provider,
    event.sessionHash ?? null,
    event.turnHash ?? null,
    event.occurredAtMs ?? null,
    event.inputTokens ?? null,
    event.cachedInputTokens ?? null,
    event.outputTokens ?? null,
    event.reasoningTokens ?? null,
    event.totalTokens ?? null,
    event.durationMs ?? null,
    event.sourceFormat,
    event.recordedAtMs
  );
  return result.changes > 0 ? 1 : 0;
}

export function putProviderHealth(database, health) {
  database.prepare(`
    INSERT INTO provider_health(
      provider, status, error_code, files_seen, files_read, bytes_read,
      lines_read, events_written, skipped_lines, backlog_sources, scanned_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      status = excluded.status,
      error_code = excluded.error_code,
      files_seen = excluded.files_seen,
      files_read = excluded.files_read,
      bytes_read = excluded.bytes_read,
      lines_read = excluded.lines_read,
      events_written = excluded.events_written,
      skipped_lines = excluded.skipped_lines,
      backlog_sources = excluded.backlog_sources,
      scanned_at_ms = excluded.scanned_at_ms
  `).run(
    health.provider,
    health.status,
    health.errorCode ?? null,
    health.filesSeen ?? 0,
    health.filesRead ?? 0,
    health.bytesRead ?? 0,
    health.linesRead ?? 0,
    health.eventsWritten ?? 0,
    health.skippedLines ?? 0,
    health.backlogSources ?? 0,
    health.scannedAtMs
  );
}

export function acquireLease(database, durationMs, nowMs = Date.now()) {
  const holder = `${process.pid}:${randomUUID()}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database.prepare("SELECT holder, expires_at_ms FROM collector_lease WHERE name = 'collect'").get();
    const holderState = current === undefined ? null : leaseHolderState(current.holder);
    const leaseStillBlocks = holderState === "running"
      || (holderState === "unknown" && current.expires_at_ms > nowMs);
    if (leaseStillBlocks) {
      database.exec("ROLLBACK");
      return null;
    }
    database.prepare(`
      UPDATE collection_run SET
        completed_at_ms = ?, status = 'error', providers_error = max(providers_error, 1)
      WHERE status = 'running'
    `).run(nowMs);
    database.prepare(`
      INSERT INTO collector_lease(name, holder, expires_at_ms) VALUES ('collect', ?, ?)
      ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at_ms = excluded.expires_at_ms
    `).run(holder, nowMs + durationMs);
    database.exec("COMMIT");
    return holder;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function leaseHolderState(holder) {
  const match = /^([1-9][0-9]*):/u.exec(holder);
  if (match === null) return "unknown";
  const holderPid = Number(match[1]);
  try {
    process.kill(holderPid, 0);
    return "running";
  } catch (error) {
    return error?.code === "EPERM" ? "running" : "dead";
  }
}

export function releaseLease(database, holder) {
  database.prepare("DELETE FROM collector_lease WHERE name = 'collect' AND holder = ?").run(holder);
}

export function startCollectionRun(database, startedAtMs = Date.now()) {
  const runId = randomUUID();
  database.prepare(`
    INSERT INTO collection_run(run_id, started_at_ms, status) VALUES (?, ?, 'running')
  `).run(runId, startedAtMs);
  return runId;
}

export function finishCollectionRun(database, runId, summary) {
  database.prepare(`
    UPDATE collection_run SET
      completed_at_ms = ?, status = ?, providers_ok = ?, providers_partial = ?,
      providers_missing = ?, providers_error = ?, events_written = ?
    WHERE run_id = ?
  `).run(
    summary.completedAtMs,
    summary.status,
    summary.providersOk,
    summary.providersPartial,
    summary.providersMissing,
    summary.providersError,
    summary.eventsWritten,
    runId
  );
}
