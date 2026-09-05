import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createClaudeParser } from "../src/providers/claude.mjs";
import { createCodexParser, scanCodex } from "../src/providers/codex.mjs";
import { scanZcode } from "../src/providers/zcode.mjs";
import { openStateDatabase } from "../src/db.mjs";
import { fixtureConfig, temporaryRoot } from "./helpers.mjs";

test("Codex parser projects wrapper and nested MCP names without raw source", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const parser = createCodexParser({ database, sourceId: "source-hash", recordedAtMs: 1000 });
    parser.onRecord({ timestamp: "2026-08-20T23:59:00.000Z", type: "session_meta", payload: { id: "session-secret" } });
    parser.onRecord({ type: "turn_context", payload: { turn_id: "turn-secret" } });
    parser.onRecord({
      timestamp: "2026-08-21T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call-secret",
        name: "exec",
        status: "completed",
        input: 'await tools.mcp__math_anchor__math_run({expression:"secret-expression"}); tools.map(Boolean);'
      }
    });
    const rows = database.prepare("SELECT tool_name, route_class, derived, status, session_hash, turn_hash, call_hash, request_bytes FROM tool_event ORDER BY derived").all();
    assert.deepEqual(rows.map((row) => row.tool_name), ["exec", "mcp__math_anchor__math_run"]);
    assert.equal(rows[1].derived, 1);
    assert.equal(rows[1].route_class, "mcp");
    assert.equal(rows[0].request_bytes, Buffer.byteLength('await tools.mcp__math_anchor__math_run({expression:"secret-expression"}); tools.map(Boolean);'));
    assert.equal(database.prepare("SELECT session_started_at_ms FROM tool_event WHERE derived = 0").get().session_started_at_ms, Date.parse("2026-08-20T23:59:00.000Z"));
    assert.equal(rows[1].request_bytes, null);
    const stored = JSON.stringify(database.prepare("SELECT * FROM tool_event").all());
    assert.equal(stored.includes("session-secret"), false);
    assert.equal(stored.includes("secret-expression"), false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex output fallback correlates repeated call IDs within the current session", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    for (const [sessionId, toolName] of [["session-a", "Read"], ["session-b", "Bash"]]) {
      const parser = createCodexParser({ database, sourceId: `source-${sessionId}`, recordedAtMs: 1000 });
      parser.onRecord({ type: "session_meta", payload: { id: sessionId } });
      parser.onRecord({
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "response_item",
        payload: { type: "function_call", call_id: "shared-call", name: toolName, status: "in_progress" }
      });
    }
    const completion = createCodexParser({ database, sourceId: "source-session-b", recordedAtMs: 2000 });
    completion.onRecord({ type: "session_meta", payload: { id: "session-b" } });
    completion.onRecord({
      timestamp: "2026-08-21T00:00:01.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "shared-call", output: "private-output" }
    });
    assert.deepEqual(database.prepare("SELECT tool_name, status FROM tool_event ORDER BY tool_name").all().map((row) => ({ ...row })), [
      { tool_name: "Bash", status: "completed" },
      { tool_name: "Read", status: "observed" }
    ]);
    assert.equal(database.prepare("SELECT response_bytes FROM tool_event WHERE tool_name = 'Bash'").get().response_bytes, 14);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude parser correlates tool result and stores usage counts only", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const parser = createClaudeParser({ database, sourceId: "source-hash", recordedAtMs: 2000 });
    parser.onRecord({
      type: "assistant",
      sessionId: "claude-session-secret",
      uuid: "assistant-message-secret",
      timestamp: "2026-08-21T00:00:00.000Z",
      message: {
        id: "message-secret",
        usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 },
        content: [{ type: "tool_use", id: "tool-secret", name: "mcp__data_transformer__data_inspect", input: { private: "value" } }]
      }
    });
    parser.onRecord({
      type: "user",
      sessionId: "claude-session-secret",
      timestamp: "2026-08-21T00:00:00.250Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-secret", is_error: true, content: "private result" }] }
    });
    parser.onRecord({
      type: "system",
      sessionId: "claude-session-secret",
      timestamp: "2026-08-20T23:59:59.000Z",
      message: { content: [] }
    });
    const tool = database.prepare("SELECT * FROM tool_event").get();
    assert.equal(tool.status, "error");
    assert.equal(tool.session_started_at_ms, Date.parse("2026-08-20T23:59:59.000Z"));
    assert.equal(tool.duration_ms, 250);
    assert.equal(tool.request_bytes, Buffer.byteLength(JSON.stringify({ private: "value" })));
    assert.equal(tool.response_bytes, Buffer.byteLength("private result"));
    const usage = { ...database.prepare("SELECT input_tokens, cached_input_tokens, output_tokens, total_tokens FROM usage_event").get() };
    assert.deepEqual(usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, total_tokens: 13 });
    const stored = JSON.stringify({ tool, usage });
    assert.equal(stored.includes("private"), false);
    assert.equal(stored.includes("claude-session-secret"), false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode adapter reads only normalized usage columns", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = new DatabaseSync(paths.zcode);
    source.exec(`
      CREATE TABLE tool_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT,
        tool_name TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
        duration_ms INTEGER, retry_count INTEGER, error_message TEXT
      );
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, status TEXT,
        started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_read_input_tokens INTEGER, computed_total_tokens INTEGER,
        raw_usage_json TEXT
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY, time_created INTEGER
      );
      INSERT INTO session VALUES ('session-secret', 1787298000000);
      INSERT INTO tool_usage VALUES (
        'row-secret', 'session-secret', 'turn-secret', 'call-secret', 'Bash',
        'running', 1787298054486, NULL, NULL, 0, 'must-not-copy'
      );
      INSERT INTO model_usage VALUES (
        'model-secret', 'session-secret', 'turn-secret', 'running',
        1787298054486, NULL, NULL, 12, 3, 2, 5, 17, '{"private":true}'
      );
    `);
    source.close();
    const database = openStateDatabase(config);
    const health = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 1787299000000 });
    assert.equal(health.status, "ok");
    assert.equal(health.eventsWritten, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 1);
    assert.equal(database.prepare("SELECT session_started_at_ms FROM tool_event").get().session_started_at_ms, 1787298000000);
    assert.equal(database.prepare("SELECT count(*) AS n FROM usage_event").get().n, 1);
    const repeat = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 1787299001000 });
    assert.equal(repeat.eventsWritten, 0);

    const update = new DatabaseSync(paths.zcode);
    update.prepare("UPDATE tool_usage SET status = ?, completed_at = ?, duration_ms = ? WHERE id = ?")
      .run("completed", 1787299001500, 100, "row-secret");
    update.prepare("UPDATE model_usage SET status = ?, completed_at = ?, duration_ms = ?, output_tokens = ?, computed_total_tokens = ? WHERE id = ?")
      .run("completed", 1787299001500, 80, 4, 18, "model-secret");
    update.close();
    const completion = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 1787299002000 });
    assert.equal(completion.eventsWritten, 2);
    assert.equal(database.prepare("SELECT status FROM tool_event").get().status, "completed");
    assert.equal(database.prepare("SELECT total_tokens FROM usage_event").get().total_tokens, 18);
    const settled = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 1787299003000 });
    assert.equal(settled.eventsWritten, 0);
    const stored = JSON.stringify({
      tools: database.prepare("SELECT * FROM tool_event").all(),
      usage: database.prepare("SELECT * FROM usage_event").all()
    });
    assert.equal(stored.includes("must-not-copy"), false);
    assert.equal(stored.includes("private"), false);
    assert.equal(stored.includes("session-secret"), false);
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM provider_checkpoint").all()).includes("row-secret"), false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode adapter reports schema drift before attempting partial ingestion", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = new DatabaseSync(paths.zcode);
    source.exec(`
      CREATE TABLE tool_usage (id TEXT PRIMARY KEY, started_at INTEGER);
      CREATE TABLE model_usage (id TEXT PRIMARY KEY, started_at INTEGER);
    `);
    source.close();
    const database = openStateDatabase(config);
    const health = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: Date.now() });
    assert.equal(health.status, "error");
    assert.equal(health.errorCode, "SOURCE_SCHEMA_UNSUPPORTED");
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM usage_event").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex incremental runs keep one usage rollup per session and complete calls by real name", () => {
  let database;
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const file = path.join(paths.codex, "rollout.jsonl");
    const line = (record) => `${JSON.stringify(record)}\n`;
    fs.writeFileSync(file,
      line({ timestamp: "2026-08-21T10:00:00.000Z", type: "session_meta", payload: { id: "session-secret" } })
      + line({ timestamp: "2026-08-21T10:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", status: "in_progress", input: "" } })
      + line({ timestamp: "2026-08-21T10:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } }));
    database = openStateDatabase(config);
    const budget = { remainingBytes: 64 * 1024 * 1024, remainingLines: 250_000, deadlineMs: Date.now() + 60_000 };
    const first = scanCodex({ database, config, minimumMtimeMs: 0, scannedAtMs: 1, budget });
    assert.equal(first.status, "ok");

    fs.appendFileSync(file,
      line({ timestamp: "2026-08-21T10:05:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "c2", name: "mcp__math_anchor__math_run", status: "in_progress" } })
      + line({ timestamp: "2026-08-21T10:05:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2" } })
      + line({ timestamp: "2026-08-21T10:05:02.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1" } })
      + line({ timestamp: "2026-08-21T10:05:03.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 20, total_tokens: 220 } } } }));
    const second = scanCodex({ database, config, minimumMtimeMs: 0, scannedAtMs: 2, budget });
    assert.equal(second.status, "ok");

    const usage = database.prepare("SELECT input_tokens, total_tokens FROM usage_event").all();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 200);
    assert.equal(usage[0].total_tokens, 220);
    const tools = database.prepare("SELECT tool_name, status FROM tool_event ORDER BY tool_name").all();
    assert.deepEqual(tools.map((row) => `${row.tool_name}=${row.status}`), [
      "exec=completed",
      "mcp__math_anchor__math_run=completed"
    ]);

    const third = scanCodex({ database, config, minimumMtimeMs: 0, scannedAtMs: 3, budget });
    const fd = fs.openSync(file, 'r');
    let observed;
    try {
      const opened = fs.fstatSync(fd), named = fs.lstatSync(file);
      observed = { opened: `${opened.dev}:${opened.ino}`, named: `${named.dev}:${named.ino}`, cursors: database.prepare('SELECT * FROM source_cursor').all() };
    } finally { fs.closeSync(fd); }
    assert.equal(third.eventsWritten, 0, JSON.stringify(observed));
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 2);
    database.close();
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex incremental scan fails closed when bounded prefix cannot recover session context", () => {
  let database;
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const file = path.join(paths.codex, "late-context.jsonl");
    const line = (record) => `${JSON.stringify(record)}\n`;
    const prefix = Array.from({ length: 9 }, (_, index) => line({
      timestamp: `2026-08-21T10:00:0${index}.000Z`,
      type: "event_msg",
      payload: { type: "unrelated" }
    })).join("");
    fs.writeFileSync(file,
      prefix
      + line({ timestamp: "2026-08-21T10:00:10.000Z", type: "session_meta", payload: { id: "session-secret" } })
      + line({ timestamp: "2026-08-21T10:00:11.000Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "Read", status: "in_progress" } }));
    database = openStateDatabase(config);
    const firstBudget = { remainingBytes: 1024 * 1024, remainingLines: 100, deadlineMs: Date.now() + 60_000 };
    const first = scanCodex({ database, config, minimumMtimeMs: 0, scannedAtMs: 1, budget: firstBudget });
    assert.equal(first.status, "ok");
    assert.equal(database.prepare("SELECT status FROM tool_event").get().status, "observed");

    fs.appendFileSync(file,
      line({ timestamp: "2026-08-21T10:00:12.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1" } }));
    const secondBudget = { remainingBytes: 1024 * 1024, remainingLines: 100, deadlineMs: Date.now() + 60_000 };
    const second = scanCodex({ database, config, minimumMtimeMs: 0, scannedAtMs: 2, budget: secondBudget });
    assert.equal(second.status, "error");
    assert.equal(second.errorCode, "SOURCE_SESSION_CONTEXT_MISSING");
    assert.equal(second.eventsWritten, 0);
    assert.equal(database.prepare("SELECT status FROM tool_event").get().status, "observed");
    database.close();
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode adapter enforces the shared row bound and paginates timestamp ties", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root, { ATO_MAX_LINES: "10" });
    const source = new DatabaseSync(paths.zcode);
    source.exec(`
      CREATE TABLE tool_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT,
        tool_name TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
        duration_ms INTEGER, retry_count INTEGER
      );
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, status TEXT,
        started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_read_input_tokens INTEGER, computed_total_tokens INTEGER
      );
    `);
    const insertTool = source.prepare("INSERT INTO tool_usage VALUES (?, 's', 't', ?, 'Read', 'completed', 1000, 1100, 100, 0)");
    const insertUsage = source.prepare("INSERT INTO model_usage VALUES (?, 's', 't', 'completed', 1000, 1100, 100, 1, 1, 0, 0, 2)");
    for (let index = 0; index < 12; index += 1) {
      insertTool.run(`tool-${String(index).padStart(2, "0")}`, `call-${index}`);
      insertUsage.run(`usage-${String(index).padStart(2, "0")}`);
    }
    source.close();

    const database = openStateDatabase(config);
    let health = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 10_000 });
    assert.equal(health.status, "partial");
    assert.equal(health.linesRead, 10);
    for (let run = 1; run <= 5 && health.status === "partial"; run += 1) {
      health = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 10_000 + run });
      assert.ok(health.linesRead <= 10);
    }
    assert.equal(health.status, "ok");
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 12);
    assert.equal(database.prepare("SELECT count(*) AS n FROM usage_event").get().n, 12);
    const settled = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: 20_000 });
    assert.equal(settled.status, "ok");
    assert.equal(settled.eventsWritten, 0);
    assert.equal(settled.linesRead, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode adapter reports zero writes when a partial scan rolls back", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = new DatabaseSync(paths.zcode);
    source.exec(`
      CREATE TABLE tool_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT,
        tool_name TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
        duration_ms INTEGER, retry_count INTEGER
      );
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, status TEXT,
        started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_read_input_tokens INTEGER, computed_total_tokens INTEGER
      );
      INSERT INTO tool_usage VALUES (
        'row-1', 'session-secret', 'turn-secret', 'call-secret', 'Bash',
        'running', 100, NULL, NULL, 0
      );
      INSERT INTO tool_usage VALUES (
        NULL, 'session-secret', 'turn-secret', 'call-secret', 'Bash',
        'running', 200, NULL, NULL, 0
      );
    `);
    source.close();
    const database = openStateDatabase(config);
    const health = scanZcode({ database, config, minimumMtimeMs: 0, scannedAtMs: Date.now() });
    assert.equal(health.status, "error");
    assert.equal(health.eventsWritten, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM provider_checkpoint").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
