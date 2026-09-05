import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { collect } from "../src/collector.mjs";
import {
  acquireLease,
  openStateDatabase,
  putSemanticExecutionEvent,
  putUsageEvent,
  releaseLease,
  startCollectionRun
} from "../src/db.mjs";
import { buildReport, isCurrentReport, REPORT_SCHEMA_VERSION } from "../src/report.mjs";
import { fixtureConfig, temporaryRoot, writeJsonl } from "./helpers.mjs";

test("repeat collection is idempotent and cannot infer retirement", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root, { ATO_DISABLE_PROVIDERS: "zcode" });
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const codexFile = path.join(paths.codex, "rollout.jsonl");
    writeJsonl(codexFile, [
      { timestamp: "2026-08-21T10:00:00.000Z", type: "session_meta", payload: { id: "s1" } },
      { timestamp: "2026-08-21T10:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", status: "completed", input: "await tools.mcp__math_anchor__math_run({});" } }
    ]);
    const claudeFile = path.join(paths.claude, "session.jsonl");
    writeJsonl(claudeFile, [
      { timestamp: "2026-08-21T10:00:00.000Z", type: "assistant", sessionId: "s2", uuid: "u1", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "secret" } }] } },
      { timestamp: "2026-08-21T10:00:00.100Z", type: "user", sessionId: "s2", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "secret" }] } }
    ]);
    const beforeCodex = fs.readFileSync(codexFile);
    const beforeClaude = fs.readFileSync(claudeFile);
    const database = openStateDatabase(config);
    const first = collect(database, config, now);
    assert.equal(first.status, "completed");
    const countsAfterFirst = {
      tools: database.prepare("SELECT count(*) AS n FROM tool_event").get().n,
      usage: database.prepare("SELECT count(*) AS n FROM usage_event").get().n
    };
    collect(database, config, now + 1000);
    assert.deepEqual({
      tools: database.prepare("SELECT count(*) AS n FROM tool_event").get().n,
      usage: database.prepare("SELECT count(*) AS n FROM usage_event").get().n
    }, countsAfterFirst);
    const report = buildReport(database, { days: 30 }, now + 1000);
    assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(isCurrentReport(report), true);
    assert.deepEqual(report.portfolio.highObservedErrorRates, []);
    assert.deepEqual(report.portfolio.repeatedUnmappedMcpUse, []);
    assert.deepEqual(report.portfolio.repeatedToolSequences, []);
    for (const retiredField of [
      "fixCandidates",
      "capabilityCandidates",
      "procedureCandidates",
      "weakenRoutingCandidates",
      "retireCandidates",
    ]) {
      assert.equal(Object.hasOwn(report.portfolio, retiredField), false);
    }
    assert.equal(report.tools.every((tool) => tool.correctnessStatus === "unknown"), true);
    assert.equal(report.tools.every((tool) => tool.opportunityStatus === "unknown"), true);
    const retiredClaimFields = ["correctness" + "Evidence", "opportunity" + "Evidence"];
    assert.equal(report.tools.every((tool) => retiredClaimFields.every((field) => !(field in tool))), true);
    assert.deepEqual(report.observationCoverage.skillUse, {
      status: "unavailable",
      reason: "supported-provider-records-do-not-expose-authoritative-skill-activation-events",
      availableInventoryIsNotUse: true
    });
    assert.equal(report.observationCoverage.resultAdoption.status, "not-observed");
    assert.equal(report.observationCoverage.nonUseReason.status, "not-observed");
    assert.deepEqual(report.activity.providers.map((item) => item.provider), ["claude", "codex"]);
    const claudeActivity = report.activity.providers.find((item) => item.provider === "claude");
    assert.equal(claudeActivity.observedSessions, 1);
    assert.equal(claudeActivity.observedActiveDays, 1);
    assert.equal(claudeActivity.longestObservedSessionSpanMs, 100);
    assert.equal(claudeActivity.currentObservedDayStreak, 1);
    assert.equal(claudeActivity.longestObservedDayStreak, 1);
    assert.match(claudeActivity.sessionDurationSemantics, /not-chat-duration/u);
    assert.equal(report.activity.daily.some((item) => item.provider === "claude" && item.utcDate === "2026-08-21"), true);
    const legacy = structuredClone(report);
    delete legacy.schemaVersion;
    legacy.tools[0]["correctness" + "Evidence"] = "unknown";
    assert.equal(isCurrentReport(legacy), false);
    database.close();
    assert.deepEqual(fs.readFileSync(codexFile), beforeCodex);
    assert.deepEqual(fs.readFileSync(claudeFile), beforeClaude);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daily activity preserves provider token semantics, peaks, and observed-day streaks", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const totals = [10, 20, 80, 30];
    const firstDay = Date.parse("2026-08-29T12:00:00.000Z");
    for (let index = 0; index < totals.length; index += 1) {
      const occurredAtMs = firstDay + index * 86_400_000;
      putUsageEvent(database, {
        eventId: `daily-${index}`,
        provider: "zcode",
        sessionHash: `session-${index}`,
        turnHash: `turn-${index}`,
        occurredAtMs,
        inputTokens: totals[index] - 2,
        outputTokens: 2,
        totalTokens: totals[index],
        sourceFormat: "test",
        recordedAtMs: occurredAtMs
      });
    }
    const report = buildReport(database, { days: 7 }, Date.parse("2026-09-01T18:00:00.000Z"));
    const activity = report.activity.providers.find((item) => item.provider === "zcode");
    const usage = report.usage.find((item) => item.provider === "zcode");
    assert.equal(activity.currentObservedDayStreak, 4);
    assert.equal(activity.longestObservedDayStreak, 4);
    assert.equal(usage.peakObservedDailyTokens, 80);
    assert.equal(usage.peakObservedDailyDate, "2026-08-31");
    assert.match(usage.dailyTokenSemantics, /provider-reported/u);
    assert.equal(report.activity.daily.length, 4);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime errors need enough measured calls before a neutral high-error observation", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const insert = database.prepare(`
      INSERT INTO tool_event(
        event_id, provider, occurred_at_ms, tool_name, route_class, is_openadam,
        derived, status, source_format, recorded_at_ms
      ) VALUES (?, 'claude', ?, 'mcp__math_anchor__math_run', 'mcp', 1, 0, ?, 'test', ?)
    `);
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) insert.run(`e${index}`, now, "error", now);
    let report = buildReport(database, { days: 1, openAdamOnly: true }, now);
    assert.equal(report.tools[0].signal, "insufficient-data");
    insert.run("e4", now, "completed", now);
    report = buildReport(database, { days: 1, openAdamOnly: true }, now);
    assert.equal(report.tools[0].signal, "high-observed-error-rate");
    assert.deepEqual(report.portfolio.highObservedErrorRates, [{
      provider: "claude",
      toolName: "mcp__math_anchor__math_run",
      measuredCalls: 5,
      errors: 4,
      errorRate: 0.8,
      basis: "minimum-measured-calls-and-observed-runtime-error-rate",
      interpretationStatus: "not-performed",
    }]);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an active collector lease prevents overlapping automatic scans", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const first = acquireLease(database, 60_000, 1000);
    assert.equal(typeof first, "string");
    assert.equal(acquireLease(database, 60_000, 1001), null);
    releaseLease(database, first);
    assert.equal(typeof acquireLease(database, 60_000, 1002), "string");
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an expired lease still prevents overlap while its holder process is alive", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const startedAtMs = 1_000;
    startCollectionRun(database, startedAtMs);
    database.prepare(`
      INSERT INTO collector_lease(name, holder, expires_at_ms)
      VALUES ('collect', ?, 1500)
    `).run(`${process.pid}:fixture`);
    assert.equal(acquireLease(database, 120_000, 2_000), null);
    assert.equal(
      database.prepare("SELECT status FROM collection_run WHERE started_at_ms = ?").get(startedAtMs).status,
      "running"
    );
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an expired legacy lease without a process identity can be reclaimed", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    database.prepare(`
      INSERT INTO collector_lease(name, holder, expires_at_ms)
      VALUES ('collect', 'legacy-holder', 1500)
    `).run();
    const reclaimed = acquireLease(database, 120_000, 2_000);
    assert.equal(typeof reclaimed, "string");
    releaseLease(database, reclaimed);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dead lease holder is reclaimed and its unfinished run is closed", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const startedAtMs = 1_000;
    startCollectionRun(database, startedAtMs);
    database.prepare(`
      INSERT INTO collector_lease(name, holder, expires_at_ms)
      VALUES ('collect', '2147483647:fixture', 120000)
    `).run();
    const reclaimed = acquireLease(database, 120_000, 2_000);
    assert.equal(typeof reclaimed, "string");
    const interrupted = database.prepare("SELECT * FROM collection_run WHERE started_at_ms = ?").get(startedAtMs);
    assert.equal(interrupted.status, "error");
    assert.equal(interrupted.completed_at_ms, 2_000);
    assert.equal(interrupted.providers_error, 1);
    releaseLease(database, reclaimed);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state database refuses a symlink target", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside.sqlite");
    fs.writeFileSync(outside, "not a database");
    fs.symlinkSync(outside, config.databasePath);
    assert.throws(() => openStateDatabase(config), { code: "STATE_FILE_INVALID" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("turn-associated usage queries retain their provider and turn indexes", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const indexes = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index'
    `).all().map((row) => row.name));
    assert.equal(indexes.has("tool_event_turn_idx"), true);
    assert.equal(indexes.has("usage_event_turn_idx"), true);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema migration discards stale derived Codex projections and reopens their cursors", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const now = Date.now();
    database.prepare("UPDATE metadata SET value = '1' WHERE key = 'schema_version'").run();
    database.prepare(`
      INSERT INTO tool_event(
        event_id, provider, source_id, occurred_at_ms, tool_name, route_class,
        is_openadam, derived, status, source_format, recorded_at_ms
      ) VALUES ('derived', 'codex', 'source', ?, 'mcp__x__y', 'mcp', 0, 1, 'observed', 'test', ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO source_cursor(
        source_id, provider, file_identity, offset_bytes, size_bytes, mtime_ms,
        discarding_line, skipped_lines, updated_at_ms
      ) VALUES ('source', 'codex', 'identity', 1, 1, ?, 0, 0, ?)
    `).run(now, now);
    database.close();

    database = openStateDatabase(config);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event WHERE event_id = 'derived'").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM source_cursor WHERE source_id = 'source'").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v3 migration purges corrupted Codex rollups for clean re-ingestion", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const now = Date.now();
    database.prepare("UPDATE metadata SET value = '3' WHERE key = 'schema_version'").run();
    for (const [eventId, provider] of [["codex-old", "codex"], ["claude-keep", "claude"]]) {
      database.prepare(`
        INSERT INTO tool_event(
          event_id, provider, occurred_at_ms, tool_name, route_class, is_openadam,
          derived, status, source_format, recorded_at_ms
        ) VALUES (?, ?, ?, 'Bash', 'native-shell', 0, 0, 'observed', 'test', ?)
      `).run(eventId, provider, now, now);
    }
    database.prepare(`
      INSERT INTO usage_event(
        event_id, provider, occurred_at_ms, input_tokens, output_tokens,
        source_format, recorded_at_ms
      ) VALUES ('codex-usage-old', 'codex', ?, 10, 2, 'test', ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO source_cursor(
        source_id, provider, file_identity, offset_bytes, size_bytes, mtime_ms,
        discarding_line, skipped_lines, updated_at_ms
      ) VALUES ('codex-source', 'codex', 'identity', 1, 1, ?, 0, 0, ?)
    `).run(now, now);
    database.close();

    database = openStateDatabase(config);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event WHERE provider = 'codex'").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM usage_event WHERE provider = 'codex'").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM source_cursor WHERE provider = 'codex'").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event WHERE provider = 'claude'").get().n, 1);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v4 migration repairs stored tool taxonomy without deleting observations", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const now = Date.now();
    database.prepare("UPDATE metadata SET value = '4' WHERE key = 'schema_version'").run();
    database.prepare(`
      INSERT INTO tool_event(
        event_id, provider, occurred_at_ms, tool_name, route_class, is_openadam,
        derived, status, source_format, recorded_at_ms
      ) VALUES ('reclassify', 'claude', ?, 'mcp__data-transformer__data_transform',
        'unknown', 0, 0, 'completed', 'test', ?)
    `).run(now, now);
    database.close();

    database = openStateDatabase(config);
    const row = { ...database.prepare(`
      SELECT tool_namespace, route_class, is_openadam
      FROM tool_event WHERE event_id = 'reclassify'
    `).get() };
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.deepEqual(row, {
      tool_namespace: "data_transformer",
      route_class: "mcp",
      is_openadam: 1
    });
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v5 migration adds the bounded ZCode tie cursor", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    database.exec("ALTER TABLE provider_checkpoint DROP COLUMN last_started_count");
    database.prepare("UPDATE metadata SET value = '5' WHERE key = 'schema_version'").run();
    database.close();

    database = openStateDatabase(config);
    const columns = database.prepare("PRAGMA table_info(provider_checkpoint)").all().map((row) => row.name);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(columns.includes("last_started_count"), true);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v7 migration adds exact receipt outcomes without losing prior rows", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const now = Date.now();
    database.prepare(`
      INSERT INTO procedure_event(
        event_id, invocation_hash, procedure_id, procedure_version,
        implementation_id, implementation_version, outcome, receipt_outcome,
        started_at_ms, completed_at_ms, duration_ms, stage_count, source_format,
        recorded_at_ms
      ) VALUES (?, ?, 'org.openadam.example', '0.1.0', 'org.openadam.example',
        '0.1.0', 'success', 'success', ?, ?, 0, 1,
        'openadam.procedure-receipt.v0.1', ?)
    `).run("a".repeat(64), "b".repeat(64), now, now, now);
    database.exec("ALTER TABLE procedure_event DROP COLUMN receipt_outcome");
    database.prepare("UPDATE metadata SET value = '7' WHERE key = 'schema_version'").run();
    database.close();

    database = openStateDatabase(config);
    const row = database.prepare(
      "SELECT outcome, receipt_outcome FROM procedure_event WHERE event_id = ?"
    ).get("a".repeat(64));
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.deepEqual({ ...row }, { outcome: "success", receipt_outcome: "success" });
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v8 migration drops the retired human-checkpoint table", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    database.exec(`
      CREATE TABLE human_checkpoint_event (
        event_id TEXT PRIMARY KEY,
        procedure_event_id TEXT NOT NULL,
        stage_index INTEGER NOT NULL,
        stage_id TEXT NOT NULL,
        status TEXT NOT NULL,
        authority TEXT NOT NULL,
        decision_source TEXT,
        duration_ms INTEGER NOT NULL,
        completed_at_ms INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      )
    `);
    database.prepare("UPDATE metadata SET value = '8' WHERE key = 'schema_version'").run();
    database.close();

    database = openStateDatabase(config);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'human_checkpoint_event'").get().n,
      0
    );
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v9 migration adds payload measurements and semantic observation tables", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const now = Date.now();
    database.prepare(`
      INSERT INTO tool_event(
        event_id, provider, occurred_at_ms, tool_name, route_class, is_openadam,
        derived, status, source_format, recorded_at_ms
      ) VALUES ('v9-tool', 'claude', ?, 'Bash', 'native-shell', 0, 0,
        'completed', 'test', ?)
    `).run(now, now);
    database.exec("ALTER TABLE tool_event DROP COLUMN response_bytes");
    database.exec("ALTER TABLE tool_event DROP COLUMN request_bytes");
    database.prepare("UPDATE metadata SET value = '9' WHERE key = 'schema_version'").run();
    database.close();

    database = openStateDatabase(config);
    const columns = new Set(database.prepare("PRAGMA table_info(tool_event)").all().map((row) => row.name));
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(columns.has("request_bytes"), true);
    assert.equal(columns.has("response_bytes"), true);
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event WHERE event_id = 'v9-tool'").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'semantic_execution_event'").get().n, 1);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema v10 migration preserves semantic observations and admits projected MCP operations", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    const base = {
      sourceId: "a".repeat(64),
      workOrderHash: `sha256:${"b".repeat(64)}`,
      callHash: `sha256:${"c".repeat(64)}`,
      occurredAtMs: 1000,
      completedAtMs: 1010,
      semanticId: null,
      semanticVersion: null,
      providerId: "io.github.tetracoralla.math-anchor",
      providerVersion: "0.3.0",
      transport: "mcp-stdio",
      lifecycle: "persistent",
      status: "ok",
      errorCode: null,
      durationMs: 10,
      queueMs: 1,
      providerRoundTripMs: 8,
      requestBytes: 100,
      responseBytes: 200,
      sessionState: "warm",
      bindingDigest: `sha256:${"d".repeat(64)}`,
      contractDigest: `sha256:${"e".repeat(64)}`,
      sourceFormat: "openadam.direct-execution-observation.v0.1",
      recordedAtMs: 1020
    };
    putSemanticExecutionEvent(database, {
      ...base,
      eventId: "f".repeat(64),
      targetKind: "mcp-tool",
      operationId: null,
      toolName: "math.batch"
    });
    database.exec(`
      DROP INDEX IF EXISTS semantic_execution_time_idx;
      DROP INDEX IF EXISTS semantic_execution_target_idx;
      DROP INDEX IF EXISTS semantic_execution_provider_idx;
      CREATE TABLE semantic_execution_event_v10 AS
        SELECT * FROM semantic_execution_event;
      DROP TABLE semantic_execution_event;
      ALTER TABLE semantic_execution_event_v10 RENAME TO semantic_execution_event;
    `);
    database.prepare("UPDATE metadata SET value = '10' WHERE key = 'schema_version'").run();
    database.close();

    database = openStateDatabase(config);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(database.prepare("SELECT count(*) AS n FROM semantic_execution_event").get().n, 1);
    assert.match(
      database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_execution_event'").get().sql,
      /mcp-operation/u
    );
    putSemanticExecutionEvent(database, {
      ...base,
      eventId: "0".repeat(64),
      targetKind: "mcp-operation",
      operationId: "calculus.derivative",
      toolName: "math.run"
    });
    assert.equal(database.prepare("SELECT count(*) AS n FROM semantic_execution_event").get().n, 2);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an additive dogfood schema 12 marker is normalized so a v11 rollback reader remains usable", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    let database = openStateDatabase(config);
    database.prepare("UPDATE metadata SET value = '12' WHERE key = 'schema_version'").run();
    database.close();
    database = openStateDatabase(config);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "11");
    assert.equal(database.prepare("SELECT count(*) AS n FROM agent_host_deployment_observation").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
