import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  openStateDatabase,
  putTraceModelStep,
  putTraceToolEvent,
  putTraceTurnEvent
} from "../src/db.mjs";
import { buildReport } from "../src/report.mjs";
import { maintainDatabase } from "../src/maintenance.mjs";
import { scanTraceBridges, validateTraceBridgeRecord } from "../src/providers/trace-bridge.mjs";
import { scanGeminiTelemetry } from "../src/providers/gemini-otel.mjs";
import { scanZcodeTrace } from "../src/providers/zcode-trace.mjs";
import { TRACE_ADAPTERS } from "../src/trace-adapters.mjs";
import { exportTraceAnalysisPack } from "../src/trace-export.mjs";
import { exportRetainedTraceAnalysisPack, listRetainedTraceSources } from "../src/retained-trace.mjs";
import { appendHookRecords, processHookInput, projectHookEvent } from "../src/hook-bridge.mjs";
import { buildAdapterPlan, listAdapterPlans } from "../src/adapter-plans.mjs";
import {
  OpenAdamObserverBridge,
  createDeepSeekEventProjector
} from "../integrations/deepseek-harness/index.mjs";
import { fixtureConfig, temporaryRoot, writeJsonl } from "./helpers.mjs";

function budget(config) {
  return {
    remainingBytes: config.limits.maxBytesPerRun,
    remainingLines: config.limits.maxLinesPerRun,
    deadlineMs: Date.now() + 30_000
  };
}

function modelIoRecord(secret = "never-store-this-content") {
  return {
    type: "model_io",
    sessionId: "session-one",
    turnId: "turn-one",
    requestId: "request-one",
    traceId: "trace-one",
    querySource: "main_turn",
    attempt: 1,
    startedAt: "2026-09-02T08:00:00.000Z",
    completedAt: "2026-09-02T08:00:01.250Z",
    durationMs: 1250,
    model: { providerId: "fixture", modelId: "fixture-model", role: "main" },
    request: {
      headers: { authorization: secret },
      providerOptions: { credential: secret },
      messages: [
        { role: "user", content: secret },
        { role: "tool", toolCallId: "call-prior", toolName: "mcp__math_anchor__math_run", isError: false, content: secret }
      ],
      messageCount: 2,
      toolNames: ["mcp__math_anchor__math_run", "exec"],
      body: secret
    },
    response: {
      finishReason: "tool-calls",
      text: secret,
      reasoningText: secret,
      headers: { "set-cookie": secret },
      providerMetadata: { internal: secret },
      toolCalls: [{ id: "call-next", name: "mcp__math_anchor__math_run", input: { expression: secret } }],
      usage: { inputTokens: 100, cacheReadTokens: 25, outputTokens: 10, totalTokens: 110 }
    },
    error: null
  };
}

function deepSeekEvents(secret = "never-store-deepseek-content") {
  return [
    { type: "request/header", seq: 1, time: 1_000, data: { header: { config: { model: "fixture-model" }, tools: [{ name: "mcp__math_anchor__math_run", description: secret }] } } },
    { type: "step/start", seq: 2, time: 1_100, data: { turn: 1, step: 1 } },
    { type: "assistant/message", seq: 3, time: 1_500, data: { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: secret }, { type: "tool-call", id: "call-one", name: "mcp__math_anchor__math_run", arguments: secret }] }, usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 3 } } },
    { type: "tool/call", seq: 4, time: 1_600, data: { turn: 1, step: 1, callId: "call-one", name: "mcp__math_anchor__math_run", arguments: secret } },
    { type: "tool/result", seq: 5, time: 1_700, data: { turn: 1, step: 1, message: { source: { callId: "call-one" }, content: secret } } },
    { type: "turn/end", seq: 6, time: 1_800, data: { turn: 1, reason: { kind: "completed" } } }
  ];
}

function deepSeekRecords(secret) {
  const session = { header: { id: "deepseek-session" } };
  const projector = createDeepSeekEventProjector({ providerVersion: "fixture" });
  return deepSeekEvents(secret).flatMap((event) => projector.project(session, event));
}

function geminiRecord(eventName, attributes = {}) {
  return {
    body: "ignored upstream body",
    attributes: {
      "session.id": "gemini-session",
      "event.name": eventName,
      "event.timestamp": "2026-09-02T10:00:00.000Z",
      ...attributes
    },
    resource: { attributes: { "service.version": "0.9.0-fixture" } }
  };
}

function writeJsonObjectStream(filePath, records, suffix = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record, null, 2)).join("\n") + suffix, { mode: 0o600 });
}

test("ZCode model-I/O trace projection retains metadata and discards all raw content", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-session-one.jsonl");
    const secret = "PRIVATE-PROMPT-ARGUMENT-RESULT-HEADER";
    writeJsonl(source, [modelIoRecord(secret)]);
    const before = fs.readFileSync(source);
    const database = openStateDatabase(config);
    const now = Date.parse("2026-09-02T08:02:00.000Z");
    const first = scanZcodeTrace({
      database,
      config,
      minimumMtimeMs: 0,
      scannedAtMs: now,
      budget: budget(config)
    });
    assert.equal(first.status, "ok");
    assert.equal(first.filesRead, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_offer").get().n, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_event WHERE kind = 'tool-call'").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_event WHERE kind = 'tool-result'").get().n, 1);
    const step = database.prepare("SELECT * FROM trace_model_step").get();
    assert.equal(step.offered_tool_count, 2);
    assert.equal(step.emitted_tool_call_count, 1);
    assert.equal(step.rationale_present, 1);
    assert.equal(step.total_tokens, 110);
    const retained = JSON.stringify({
      steps: database.prepare("SELECT * FROM trace_model_step").all(),
      offers: database.prepare("SELECT * FROM trace_tool_offer").all(),
      events: database.prepare("SELECT * FROM trace_tool_event").all(),
      cursors: database.prepare("SELECT * FROM trace_cursor").all()
    });
    assert.equal(retained.includes(secret), false);
    assert.equal(retained.includes(source), false);
    const report = buildReport(database, { days: 30 }, now);
    assert.equal(report.tracePlane.providers[0].provider, "zcode");
    assert.equal(report.tracePlane.providers[0].modelSteps, 1);
    assert.equal(report.tracePlane.toolOffers.length, 2);
    assert.equal(report.tracePlane.interpretationStatus, "not-performed");
    assert.equal(report.tracePlane.providers[0].correctnessStatus, "unknown");
    assert.equal(report.observationCoverage.toolOffer.offeredIsNotSkillActivationOrUse, true);

    const second = scanZcodeTrace({
      database,
      config,
      minimumMtimeMs: 0,
      scannedAtMs: now + 1000,
      budget: budget(config)
    });
    assert.equal(second.eventsWritten, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.deepEqual(fs.readFileSync(source), before);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook-only providers remain visible in Trace Plane without a model-step row", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const now = Date.parse("2026-09-02T11:00:00.000Z");
    const common = {
      provider: "github-copilot-cli",
      adapterId: "openadam.github-copilot-cli-hooks",
      adapterVersion: "0.1.0",
      providerVersion: "1.0.0",
      sourceId: "2".repeat(64),
      sessionHash: "3".repeat(64),
      turnHash: "4".repeat(64),
      callHash: "5".repeat(64),
      sourceFormat: "github-copilot-cli-hook-json-v1",
      occurredAtMs: now - 1_000,
      recordedAtMs: now
    };
    putTraceToolEvent(database, {
      ...common,
      eventId: "6".repeat(64),
      kind: "tool-call",
      toolName: "mcp__math_anchor__math_run",
      status: "observed"
    });
    putTraceToolEvent(database, {
      ...common,
      eventId: "7".repeat(64),
      kind: "tool-result",
      toolName: "mcp__math_anchor__math_run",
      status: "completed",
      completedAtMs: now - 500
    });

    const report = buildReport(database, { days: 30 }, now);
    const provider = report.tracePlane.providers.find((entry) => entry.provider === "github-copilot-cli");
    assert.equal(provider.modelSteps, 0);
    assert.equal(provider.traceToolCalls, 1);
    assert.equal(provider.traceToolResults, 1);
    assert.equal(provider.correctnessStatus, "unknown");
    assert.equal(provider.adoptionStatus, "not-observed");
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode trace cursor waits for a complete line and recovers without duplicate steps", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-partial.jsonl");
    const line = JSON.stringify(modelIoRecord());
    fs.writeFileSync(source, line.slice(0, -5), { mode: 0o600 });
    const database = openStateDatabase(config);
    const now = Date.parse("2026-09-02T08:02:00.000Z");
    const first = scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: now, budget: budget(config) });
    assert.equal(first.eventsWritten, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 0);
    fs.appendFileSync(source, `${line.slice(-5)}\n`);
    const second = scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: now + 1, budget: budget(config) });
    assert.equal(second.filesRead, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode trace rejects symlinked trajectory files without reading their target", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const outside = path.join(root, "outside.jsonl");
    writeJsonl(outside, [modelIoRecord()]);
    fs.symlinkSync(outside, path.join(paths.zcodeTrace, "model-io-link.jsonl"));
    const database = openStateDatabase(config);
    const result = scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: Date.now(), budget: budget(config) });
    assert.equal(result.status, "missing");
    assert.equal(result.filesRead, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZCode trace shares a constrained scan across older and newer files", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const smaller = path.join(paths.zcodeTrace, "model-io-smaller.jsonl");
    const larger = path.join(paths.zcodeTrace, "model-io-larger.jsonl");
    const smallRecord = modelIoRecord("small");
    smallRecord.response.text = "s".repeat(900_000);
    smallRecord.requestId = "small-request";
    const largeRecords = Array.from({ length: 7 }, (_, index) => {
      const record = modelIoRecord("large");
      record.response.text = "l".repeat(900_000);
      record.requestId = `large-request-${index}`;
      record.turnId = `large-turn-${index}`;
      return record;
    });
    writeJsonl(smaller, [smallRecord]);
    writeJsonl(larger, largeRecords);
    const now = Date.now();
    fs.utimesSync(smaller, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(larger, new Date(now), new Date(now));
    const database = openStateDatabase(config);
    const constrained = {
      remainingBytes: 5 * 1024 * 1024,
      remainingLines: 20,
      deadlineMs: Date.now() + 30_000
    };
    const result = scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: now, budget: constrained });
    assert.equal(result.filesRead, 2);
    assert.equal(result.backlogSources, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_cursor").get().n, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step WHERE request_hash IS NOT NULL").get().n >= 2, true);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Gemini CLI OTel file projection parses concatenated objects and drops all content-bearing attributes", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const source = config.geminiTelemetryLogs[0];
    const secret = "GEMINI-PROMPT-ARGUMENT-RESULT";
    writeJsonObjectStream(source, [
      geminiRecord("gemini_cli.api_request", { prompt_id: "prompt-one", model: "gemini-fixture" }),
      geminiRecord("gemini_cli.api_response", {
        prompt_id: "prompt-one", model: "gemini-fixture", duration_ms: 250,
        input_token_count: 10, cached_content_token_count: 3, output_token_count: 4,
        thoughts_token_count: 2, total_token_count: 14, finish_reasons: ["stop"]
      }),
      geminiRecord("gemini_cli.tool_call", {
        prompt_id: "prompt-one", function_name: "mcp__math_anchor__math_run",
        duration_ms: 30, success: true, content_length: 42
      }),
      geminiRecord("gemini_cli.tool_call", {
        prompt_id: "prompt-one", function_name: "Bash", success: true, function_args: secret
      })
    ], "\n");
    const database = openStateDatabase(config);
    const first = scanGeminiTelemetry({ database, config, scannedAtMs: Date.parse("2026-09-02T10:01:00.000Z"), budget: budget(config) });
    assert.equal(first[0].status, "partial");
    assert.equal(first[0].errorCode, "TRACE_SOURCE_CONTENT_POLICY_FILTERED");
    assert.equal(first[0].skippedLines, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_event").get().n, 2);
    const step = database.prepare("SELECT * FROM trace_model_step").get();
    assert.equal(step.total_tokens, 14);
    assert.equal(step.reasoning_tokens, 2);
    assert.equal(step.provider_version, "0.9.0-fixture");
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM trace_tool_event").all()).includes(secret), false);
    assert.deepEqual(scanGeminiTelemetry({ database, config, scannedAtMs: Date.parse("2026-09-02T10:02:00.000Z"), budget: budget(config) }), []);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Gemini CLI OTel cursor waits at an incomplete JSON object and resumes exactly once", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const source = config.geminiTelemetryLogs[0];
    const serialized = JSON.stringify(geminiRecord("gemini_cli.api_response", {
      prompt_id: "prompt-partial", model: "gemini-fixture", total_token_count: 7
    }), null, 2);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, serialized.slice(0, -1), { mode: 0o600 });
    const database = openStateDatabase(config);
    const first = scanGeminiTelemetry({ database, config, scannedAtMs: 2_000, budget: budget(config) });
    assert.equal(first[0].status, "partial");
    assert.equal(first[0].eventsWritten, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 0);
    fs.appendFileSync(source, "}\n");
    const second = scanGeminiTelemetry({ database, config, scannedAtMs: 3_000, budget: budget(config) });
    assert.equal(second[0].status, "ok");
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.deepEqual(scanGeminiTelemetry({ database, config, scannedAtMs: 4_000, budget: budget(config) }), []);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace Analysis Pack is metadata-only by default and writes one exclusive owner-only file", () => {
  const root = temporaryRoot();
  try {
    const source = path.join(root, "model-io-export.jsonl");
    const output = path.join(root, "pack.json");
    const secret = "PROMPT-AND-RESULT-SECRET";
    writeJsonl(source, [modelIoRecord(secret)]);
    const result = exportTraceAnalysisPack({
      provider: "zcode",
      file: source,
      output,
      nowMs: Date.parse("2026-09-02T09:00:00.000Z")
    });
    assert.equal(result.status, "completed");
    assert.equal(result.contentPolicy, "metadata-only");
    const bytes = fs.readFileSync(output, "utf8");
    const pack = JSON.parse(bytes);
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes(source), false);
    assert.equal(pack.privacy.sourcePathIncluded, false);
    assert.equal(pack.privacy.observerDatabaseRetention, false);
    assert.equal(pack.privacy.selectedContentMayContainUserSecrets, false);
    assert.equal(pack.events[0].selectedContent, undefined);
    assert.equal(pack.interpretationStatus, "not-performed");
    if (process.platform !== "win32") assert.equal(fs.lstatSync(output).mode & 0o077, 0);
    assert.throws(() => exportTraceAnalysisPack({ provider: "zcode", file: source, output }), { code: "TRACE_OUTPUT_EXISTS" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace sources are bounded and one explicit session exports metadata-only v0.2", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-retained.jsonl");
    const output = path.join(root, "retained-pack.json");
    const secret = "RETAINED-PROMPT-ARGUMENT-RESULT-PATH";
    writeJsonl(source, [modelIoRecord(secret)]);
    const database = openStateDatabase(config);
    scanZcodeTrace({
      database,
      config,
      minimumMtimeMs: 0,
      scannedAtMs: Date.parse("2026-09-02T08:02:00.000Z"),
      budget: budget(config)
    });
    const sessionHash = database.prepare("SELECT session_hash FROM trace_model_step").get().session_hash;
    const before = {
      steps: database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n,
      tools: database.prepare("SELECT count(*) AS n FROM trace_tool_event").get().n,
      turns: database.prepare("SELECT count(*) AS n FROM trace_turn_event").get().n
    };
    const catalog = listRetainedTraceSources(database, config, {
      provider: "zcode",
      nowMs: Date.parse("2026-09-03T08:00:00.000Z"),
      limit: 1
    });
    assert.equal(catalog.schemaVersion, "openadam.agent-host-trace-source-catalog.v0.1");
    assert.equal(catalog.sources.length, 1);
    assert.equal(catalog.sources[0].sessionHash, sessionHash);
    assert.equal(catalog.sources[0].modelSteps, 1);
    assert.equal(catalog.sources[0].toolCalls, 1);
    assert.equal(catalog.sources[0].toolResults, 1);
    assert.equal(catalog.sources[0].completeness, "unknown");
    assert.equal(JSON.stringify(catalog).includes(source), false);
    const validator = new Ajv2020({ allErrors: true, strict: true });
    addFormats(validator);
    const validateCatalog = validator.compile(JSON.parse(fs.readFileSync(new URL("../../../schemas/agent-host-trace-source-catalog.schema.v0.1.json", import.meta.url), "utf8")));
    assert.equal(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));

    const result = exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode",
      sessionHash,
      output,
      nowMs: Date.parse("2026-09-03T08:00:00.000Z")
    });
    assert.equal(result.schemaVersion, "openadam.agent-host-trace-analysis-pack.v0.2");
    const text = fs.readFileSync(output, "utf8");
    const pack = JSON.parse(text);
    const validatePack = validator.compile(JSON.parse(fs.readFileSync(new URL("../../../schemas/agent-host-trace-analysis-pack.schema.v0.2.json", import.meta.url), "utf8")));
    assert.equal(validatePack(pack), true, JSON.stringify(validatePack.errors));
    assert.equal(pack.source.selectionKind, "observer-retained-session");
    assert.equal(pack.source.sessionHash, sessionHash);
    assert.equal(pack.source.completeness, "unknown");
    assert.equal(pack.privacy.sourceUsesObserverRetainedMetadata, true);
    assert.equal(pack.privacy.selectedConversationContentIncluded, false);
    assert.equal(pack.events.some((event) => event.kind === "model-step"), true);
    assert.equal(pack.events.some((event) => event.kind === "tool-call"), true);
    assert.equal(pack.events.some((event) => event.kind === "tool-result"), true);
    const modelStep = pack.events.find((event) => event.kind === "model-step");
    const offeredCatalog = pack.offeredToolCatalogs.find(
      (catalog) => catalog.catalogHash === modelStep.facts.offeredToolCatalogHash
    );
    assert.equal(offeredCatalog.tools.length, 2);
    assert.equal("offeredTools" in modelStep.facts, false);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(source), false);
    assert.deepEqual({
      steps: database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n,
      tools: database.prepare("SELECT count(*) AS n FROM trace_tool_event").get().n,
      turns: database.prepare("SELECT count(*) AS n FROM trace_turn_event").get().n
    }, before);
    if (process.platform !== "win32") assert.equal(fs.lstatSync(output).mode & 0o077, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace packs intern repeated offered-tool catalogs once", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-repeated-catalog.jsonl");
    const first = modelIoRecord();
    const second = structuredClone(first);
    second.turnId = "turn-two";
    second.requestId = "request-two";
    second.startedAt = "2026-09-02T08:01:00.000Z";
    second.completedAt = "2026-09-02T08:01:01.250Z";
    writeJsonl(source, [first, second]);
    const database = openStateDatabase(config);
    scanZcodeTrace({
      database,
      config,
      minimumMtimeMs: 0,
      scannedAtMs: Date.parse("2026-09-02T08:02:00.000Z"),
      budget: budget(config)
    });
    const sessionHash = database.prepare("SELECT session_hash FROM trace_model_step LIMIT 1").get().session_hash;
    const output = path.join(root, "interned-pack.json");
    exportRetainedTraceAnalysisPack(database, config, { provider: "zcode", sessionHash, output });
    const pack = JSON.parse(fs.readFileSync(output, "utf8"));
    const modelSteps = pack.events.filter((event) => event.kind === "model-step");
    assert.equal(modelSteps.length, 2);
    assert.equal(pack.offeredToolCatalogs.length, 1);
    assert.equal(new Set(modelSteps.map((event) => event.facts.offeredToolCatalogHash)).size, 1);
    assert.equal(pack.offeredToolCatalogs[0].tools.length, 2);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("byte-bounded retained trace packs prune catalogs whose events were dropped", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-bounded-catalogs.jsonl");
    const records = Array.from({ length: 12 }, (_, index) => {
      const record = modelIoRecord();
      record.turnId = `turn-${index}`;
      record.requestId = `request-${index}`;
      record.startedAt = new Date(Date.parse("2026-09-02T08:00:00.000Z") + index * 1_000).toISOString();
      record.completedAt = new Date(Date.parse(record.startedAt) + 500).toISOString();
      record.request.toolNames = Array.from(
        { length: 10 },
        (_, toolIndex) => `mcp__fixture_${index}__${"x".repeat(64)}_${toolIndex}`
      );
      return record;
    });
    writeJsonl(source, records);
    const database = openStateDatabase(config);
    scanZcodeTrace({
      database,
      config,
      minimumMtimeMs: 0,
      scannedAtMs: Date.parse("2026-09-02T08:02:00.000Z"),
      budget: budget(config)
    });
    const sessionHash = database.prepare("SELECT session_hash FROM trace_model_step LIMIT 1").get().session_hash;
    const output = path.join(root, "bounded-catalog-pack.json");
    exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode",
      sessionHash,
      maxOutputBytes: 4_096,
      output
    });
    const bytes = fs.readFileSync(output);
    const pack = JSON.parse(bytes);
    const referenced = new Set(pack.events
      .filter((event) => event.kind === "model-step")
      .map((event) => event.facts.offeredToolCatalogHash));
    const retained = new Set(pack.offeredToolCatalogs.map((catalog) => catalog.catalogHash));
    assert.equal(pack.limits.outputTruncated, true);
    assert.ok(pack.limits.eventsReturned < records.length);
    assert.ok(bytes.length <= 4_096);
    assert.deepEqual(retained, referenced);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace export fails closed for invalid, mixed, unavailable, and content-bearing selections", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root);
    const source = path.join(paths.zcodeTrace, "model-io-selection.jsonl");
    writeJsonl(source, [modelIoRecord()]);
    const database = openStateDatabase(config);
    scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: 2_000, budget: budget(config) });
    const sessionHash = database.prepare("SELECT session_hash FROM trace_model_step").get().session_hash;
    assert.throws(() => listRetainedTraceSources(database, config, { provider: "ZCode" }), { code: "TRACE_PROVIDER_INVALID" });
    assert.throws(() => listRetainedTraceSources(database, config, { provider: "zcode", fromMs: 2, toMs: 1 }), { code: "TRACE_RANGE_INVALID" });
    assert.throws(() => exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode", sessionHash: "f".repeat(64), output: path.join(root, "missing.json")
    }), { code: "TRACE_SESSION_NOT_FOUND" });
    assert.throws(() => exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode", sessionHash, fromMs: Date.parse("2027-01-01T00:00:00.000Z"), output: path.join(root, "empty.json")
    }), { code: "TRACE_SESSION_RANGE_EMPTY" });
    assert.throws(() => exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode", sessionHash, output: path.join(root, "content.json"), includeSelectedContent: true
    }), { code: "TRACE_CONTENT_UNAVAILABLE" });
    assert.throws(() => exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode", sessionHash, output: path.join(root, "missing", "pack.json")
    }), { code: "TRACE_OUTPUT_DIRECTORY_INVALID" });
    assert.equal(fs.existsSync(path.join(root, "missing.json")), false);
    assert.equal(fs.existsSync(path.join(root, "empty.json")), false);
    assert.equal(fs.existsSync(path.join(root, "content.json")), false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace discovery and export support a hook-only provider without manufacturing model facts", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const sessionHash = "3".repeat(64);
    putTraceToolEvent(database, {
      eventId: "2".repeat(64),
      provider: "github-copilot-cli",
      adapterId: "openadam.github-copilot-cli-hooks",
      adapterVersion: "0.1.0",
      providerVersion: "1.0.0",
      sourceId: "4".repeat(64),
      sessionHash,
      turnHash: "5".repeat(64),
      requestHash: null,
      callHash: "6".repeat(64),
      kind: "tool-result",
      occurredAtMs: 1_000,
      completedAtMs: 1_100,
      toolName: "mcp__math_anchor__math_run",
      status: "completed",
      requestBytes: 20,
      responseBytes: 10,
      sourceFormat: "github-copilot-cli-hook-json-v1",
      recordedAtMs: 1_200
    });
    const catalog = listRetainedTraceSources(database, config, { provider: "github-copilot-cli", nowMs: 2_000 });
    assert.deepEqual(catalog.sources.map((item) => [item.sessionHash, item.modelSteps, item.toolResults]), [[sessionHash, 0, 1]]);
    const output = path.join(root, "copilot.json");
    exportRetainedTraceAnalysisPack(database, config, { provider: "github-copilot-cli", sessionHash, output, nowMs: 2_000 });
    const pack = JSON.parse(fs.readFileSync(output, "utf8"));
    const validator = new Ajv2020({ allErrors: true, strict: true });
    addFormats(validator);
    const validatePack = validator.compile(JSON.parse(fs.readFileSync(new URL("../../../schemas/agent-host-trace-analysis-pack.schema.v0.2.json", import.meta.url), "utf8")));
    assert.equal(validatePack(pack), true, JSON.stringify(validatePack.errors));
    assert.equal(pack.events.length, 1);
    assert.deepEqual(pack.offeredToolCatalogs, []);
    assert.equal(pack.events[0].kind, "tool-result");
    assert.equal(pack.events[0].facts.toolName, "mcp__math_anchor__math_run");
    assert.equal("modelId" in pack.events[0].facts, false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace catalogs and packs keep deterministic source, event, and byte bounds", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const olderSession = "7".repeat(64);
    const newerSession = "8".repeat(64);
    for (let index = 0; index < 12; index += 1) {
      putTraceToolEvent(database, {
        eventId: index.toString(16).padStart(64, "0"),
        provider: "zcode",
        adapterId: "openadam.zcode-model-io",
        adapterVersion: "0.4.0",
        providerVersion: "0.16.5",
        sourceId: "9".repeat(64),
        sessionHash: olderSession,
        turnHash: null,
        requestHash: null,
        callHash: null,
        kind: "tool-result",
        occurredAtMs: 1_000 + index,
        completedAtMs: 1_000 + index,
        toolName: `mcp__fixture__${"x".repeat(180)}${index}`,
        status: "completed",
        requestBytes: 10,
        responseBytes: 20,
        sourceFormat: "fixture-json-v1",
        recordedAtMs: 1_000 + index
      });
    }
    putTraceToolEvent(database, {
      eventId: "f".repeat(64),
      provider: "zcode",
      adapterId: "openadam.zcode-model-io",
      adapterVersion: "0.4.0",
      providerVersion: "0.16.5",
      sourceId: "9".repeat(64),
      sessionHash: newerSession,
      turnHash: null,
      requestHash: null,
      callHash: null,
      kind: "tool-result",
      occurredAtMs: 2_000,
      completedAtMs: 2_000,
      toolName: "mcp__fixture__newest",
      status: "completed",
      requestBytes: 10,
      responseBytes: 20,
      sourceFormat: "fixture-json-v1",
      recordedAtMs: 2_000
    });

    const catalog = listRetainedTraceSources(database, config, { provider: "zcode", limit: 1, nowMs: 3_000 });
    assert.deepEqual(catalog.sources.map((source) => source.sessionHash), [newerSession]);
    assert.equal(catalog.limits.sourceLimitReached, true);

    const eventBoundOutput = path.join(root, "event-bound.json");
    exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode",
      sessionHash: olderSession,
      maxEvents: 3,
      maxOutputBytes: 64 * 1024,
      output: eventBoundOutput,
      nowMs: 3_000
    });
    const eventBoundPack = JSON.parse(fs.readFileSync(eventBoundOutput, "utf8"));
    assert.equal(eventBoundPack.limits.eventLimitReached, true);
    assert.equal(eventBoundPack.limits.eventsAvailable, 12);
    assert.equal(eventBoundPack.limits.eventsReturned, 3);
    assert.deepEqual(eventBoundPack.events.map((event) => event.ordinal), [0, 1, 2]);

    const byteBoundOutput = path.join(root, "byte-bound.json");
    exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode",
      sessionHash: olderSession,
      maxEvents: 12,
      maxOutputBytes: 4_096,
      output: byteBoundOutput,
      nowMs: 3_000
    });
    const byteBoundPack = JSON.parse(fs.readFileSync(byteBoundOutput, "utf8"));
    assert.equal(byteBoundPack.limits.outputTruncated, true);
    assert.equal(byteBoundPack.limits.eventsAvailable, 12);
    assert.ok(byteBoundPack.limits.eventsReturned < 12);
    assert.ok(fs.statSync(byteBoundOutput).size <= 4_096);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained trace reads fail with one stable error when an older database lacks the trace schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    assert.throws(
      () => listRetainedTraceSources(database, { limits: { retentionDays: 30 } }, { provider: "zcode" }),
      { code: "TRACE_STATE_SCHEMA_UNAVAILABLE" }
    );
  } finally {
    database.close();
  }
});

test("selected-content export requires explicit confirmation and redacts transport credentials", () => {
  const root = temporaryRoot();
  try {
    const source = path.join(root, "model-io-sensitive.jsonl");
    const output = path.join(root, "sensitive-pack.json");
    const record = modelIoRecord("USER-CONTENT");
    record.request.headers.authorization = "HEADER-CREDENTIAL";
    record.request.providerOptions.credential = "PROVIDER-CREDENTIAL";
    record.response.headers["set-cookie"] = "COOKIE-CREDENTIAL";
    record.response.providerMetadata.internal = "PROVIDER-METADATA";
    writeJsonl(source, [record]);
    assert.throws(() => exportTraceAnalysisPack({
      provider: "zcode",
      file: source,
      output,
      includeSelectedContent: true
    }), { code: "TRACE_CONTENT_CONFIRMATION_REQUIRED" });
    exportTraceAnalysisPack({
      provider: "zcode",
      file: source,
      output,
      includeSelectedContent: true,
      confirmSensitiveContent: true
    });
    const text = fs.readFileSync(output, "utf8");
    const pack = JSON.parse(text);
    assert.equal(pack.privacy.contentPolicy, "selected-content");
    assert.equal(text.includes("USER-CONTENT"), true);
    assert.equal(text.includes("HEADER-CREDENTIAL"), false);
    assert.equal(text.includes("PROVIDER-CREDENTIAL"), false);
    assert.equal(text.includes("COOKIE-CREDENTIAL"), false);
    assert.equal(text.includes("PROVIDER-METADATA"), false);
    assert.equal(pack.privacy.transportSecretsExcluded, true);
    assert.equal(pack.privacy.selectedContentMayContainUserSecrets, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace Analysis Pack enforces complete output bytes by dropping only tail events", () => {
  const root = temporaryRoot();
  try {
    const source = path.join(root, "model-io-many.jsonl");
    const output = path.join(root, "bounded-pack.json");
    const records = Array.from({ length: 30 }, (_, index) => {
      const record = modelIoRecord(`content-${index}`);
      record.requestId = `request-${index}`;
      record.turnId = `turn-${index}`;
      return record;
    });
    writeJsonl(source, records);
    exportTraceAnalysisPack({
      provider: "zcode",
      file: source,
      output,
      limits: { maxOutputBytes: 12_000 }
    });
    const bytes = fs.readFileSync(output);
    const pack = JSON.parse(bytes);
    assert.equal(bytes.length <= 12_000, true);
    assert.equal(pack.limits.outputTruncated, true);
    assert.equal(pack.events.length < 30, true);
    assert.deepEqual(pack.events.map((event) => event.ordinal), Array.from({ length: pack.events.length }, (_, index) => index));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace adapter catalog is closed, passive, and capability-negotiated", () => {
  assert.deepEqual(TRACE_ADAPTERS.map((adapter) => adapter.id), [
    "openadam.claude-code-hooks",
    "openadam.claude-project-events",
    "openadam.codex-session-events",
    "openadam.deepseek-harness-session-events",
    "openadam.gemini-cli-otel",
    "openadam.github-copilot-cli-hooks",
    "openadam.zcode-model-io"
  ]);
  assert.equal(TRACE_ADAPTERS.every((adapter) => adapter.collection.passiveMetadata === true), true);
  assert.equal(TRACE_ADAPTERS.every((adapter) => adapter.content.passiveStorage === "metadata-only"), true);
});

test("adapter plans separate automatic reads from explicit shell configuration", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const launcher = path.join(config.stateDir, "runtime", "trace-hook.mjs");
    fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
    fs.writeFileSync(launcher, "export {};\n", { mode: 0o600 });
    const nodePath = path.join(root, "node");
    fs.writeFileSync(nodePath, "fixture", { mode: 0o700 });

    const catalog = listAdapterPlans();
    assert.equal(catalog.adapters.length, 7);
    assert.equal(catalog.adapters.find((item) => item.id === "openadam.zcode-model-io").configuration, "automatic-read-only-discovery");

    const zcode = buildAdapterPlan(config, "openadam.zcode-model-io", { homeDirectory: root, nodePath });
    assert.equal(zcode.appliesChanges, false);
    assert.equal(zcode.configuration.userConfigurationRequired, false);

    const gemini = buildAdapterPlan(config, "openadam.gemini-cli-otel", { homeDirectory: root, nodePath });
    assert.equal(gemini.configuration.fragment.telemetry.logPrompts, false);
    assert.equal(gemini.configuration.fragment.telemetry.outfile, config.geminiTelemetryLogs[0]);

    const claude = buildAdapterPlan(config, "openadam.claude-code-hooks", { homeDirectory: root, nodePath, platformName: "darwin", environment: {} });
    assert.equal(Object.values(claude.configuration.fragment.hooks).flat().every((item) => item.hooks[0].async === true), true);
    assert.equal(JSON.stringify(claude).includes(JSON.stringify(root).slice(1, -1)), true);

    const copilot = buildAdapterPlan(config, "openadam.github-copilot-cli-hooks", { homeDirectory: root, nodePath, environment: {} });
    assert.equal(copilot.configuration.kind, "write-owned-json");
    assert.equal("preToolUse" in copilot.configuration.document.hooks, false);
    assert.deepEqual(Object.keys(copilot.configuration.document.hooks), ["postToolUse", "postToolUseFailure", "agentStop", "sessionEnd"]);

    const deepseek = buildAdapterPlan(config, "openadam.deepseek-harness-session-events", { homeDirectory: root, nodePath });
    assert.equal(deepseek.configuration.publicEvent, "session/event");
    assert.match(deepseek.configuration.module, /integrations[/\\]deepseek-harness[/\\]index\.mjs$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness public session events project to metadata-only bridge records", () => {
  const secret = "DEEPSEEK-PROMPT-REASONING-ARGUMENT-RESULT";
  const records = deepSeekRecords(secret);
  assert.deepEqual(records.map((record) => record.kind), ["model-step", "tool-offer", "tool-call", "tool-result", "turn-end"]);
  assert.equal(records[0].selfReportedRationalePresent, true);
  assert.equal(records[0].offeredToolCount, 1);
  assert.equal(records[0].emittedToolCallCount, 1);
  assert.equal(records[0].inputTokens, 10);
  assert.equal(records[0].cachedInputTokens, 4);
  assert.equal(records.every((record) => record.contentIncluded === false), true);
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(JSON.stringify(records).includes("deepseek-session"), false);
  assert.equal(JSON.stringify(records).includes("call-one"), false);
  assert.match(records[0].sessionId, /^[a-f0-9]{64}$/u);
  for (const record of records) assert.doesNotThrow(() => validateTraceBridgeRecord(record));
});

test("Trace Analysis Pack reports stable source/output errors and never overwrites an output", () => {
  const root = temporaryRoot();
  try {
    const source = path.join(root, "missing.jsonl");
    const output = path.join(root, "pack.json");
    assert.throws(() => exportTraceAnalysisPack({ provider: "zcode", file: source, output }), { code: "TRACE_SOURCE_UNAVAILABLE" });
    writeJsonl(source, [modelIoRecord()]);
    fs.writeFileSync(output, "owner content", { mode: 0o600 });
    assert.throws(() => exportTraceAnalysisPack({ provider: "zcode", file: source, output }), { code: "TRACE_OUTPUT_EXISTS" });
    assert.equal(fs.readFileSync(output, "utf8"), "owner content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude and Copilot official hooks project only bounded metadata and pseudonymous ids", () => {
  const secret = "HOOK-PROMPT-ARGUMENT-RESULT-PATH";
  const cases = [
    {
      adapterId: "openadam.claude-code-hooks",
      eventName: "PreToolUse",
      payload: { session_id: "claude-session", tool_use_id: "claude-call", tool_name: "Read", tool_input: { file_path: secret }, cwd: secret, transcript_path: secret }
    },
    {
      adapterId: "openadam.github-copilot-cli-hooks",
      eventName: "postToolUse",
      payload: { sessionId: "copilot-session", toolCallId: "copilot-call", toolName: "shell", toolResult: secret, cwd: secret, success: true, timestamp: "2026-09-02T10:00:00.000Z" }
    }
  ];
  const records = cases.flatMap((value) => projectHookEvent({ ...value, nowMs: 1_000 }));
  assert.deepEqual(records.map((record) => record.kind), ["tool-call", "tool-call", "tool-result"]);
  assert.deepEqual(records.map((record) => record.status), ["observed", "observed", "completed"]);
  assert.equal(records[0].requestBytes > 0, true);
  assert.equal(records[2].responseBytes > 0, true);
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(JSON.stringify(records).includes("claude-session"), false);
  assert.equal(JSON.stringify(records).includes("copilot-call"), false);
  for (const record of records) assert.doesNotThrow(() => validateTraceBridgeRecord(record));
});

test("official hook bridge appends one valid line and ignores unsupported events", () => {
  const root = temporaryRoot();
  try {
    const output = path.join(root, "bridges", "claude-hooks.jsonl");
    const written = processHookInput({
      adapterId: "openadam.claude-code-hooks",
      eventName: "PostToolUseFailure",
      output,
      input: JSON.stringify({ session_id: "s", tool_use_id: "c", tool_name: "Bash", error: "private error" }),
      nowMs: 2_000
    });
    assert.equal(written.eventsWritten, 1);
    const record = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(record.status, "error");
    assert.equal(record.stableErrorCode, "HOOK_TOOL_FAILED");
    assert.equal(JSON.stringify(record).includes("private error"), false);
    assert.equal(appendHookRecords(output, projectHookEvent({
      adapterId: "openadam.claude-code-hooks",
      eventName: "Notification",
      payload: { session_id: "s", message: "private" },
      nowMs: 3_000
    })).eventsWritten, 0);
    assert.equal(fs.readFileSync(output, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness bridge writes asynchronously, owns one output, and drains on disposal", async () => {
  const root = temporaryRoot();
  try {
    const output = path.join(root, "bridges", "deepseek-harness.jsonl");
    const handlers = new Map();
    let cleanup;
    const warnings = [];
    const context = {
      on(name, handler) { handlers.set(name, handler); },
      effect(setup) { cleanup = setup(); },
      logger: { warn(value) { warnings.push(value); } }
    };
    const bridge = new OpenAdamObserverBridge(context, { output, providerVersion: "fixture", batchDelayMs: 5_000 });
    assert.throws(() => new OpenAdamObserverBridge(context, { output }), /already owned/u);
    const session = { header: { id: "deepseek-session" } };
    for (const event of deepSeekEvents()) handlers.get("session/event")(session, event);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    await cleanup();
    const records = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 5);
    assert.equal(fs.existsSync(`${output}.lock`), false);
    assert.deepEqual(warnings, []);
    assert.equal(bridge.dropped, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace bridge ingestion is atomic, idempotent, and exposes invalid first-record health", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const source = config.traceBridgeLogs.find((candidate) => candidate.endsWith("deepseek-harness.jsonl"));
    const secret = "BRIDGE-RAW-CONTENT";
    const database = openStateDatabase(config);
    writeJsonl(source, deepSeekRecords(secret));
    const first = scanTraceBridges({ database, config, scannedAtMs: 2_000, budget: budget(config) });
    assert.equal(first[0].status, "ok");
    assert.equal(first[0].eventsWritten, 5);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_offer").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_event").get().n, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_turn_event").get().n, 1);
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM trace_tool_event").all()).includes(secret), false);
    assert.deepEqual(scanTraceBridges({ database, config, scannedAtMs: 3_000, budget: budget(config) }), []);

    fs.writeFileSync(source, `${JSON.stringify({ ...deepSeekRecords()[0], contentIncluded: true })}\n`, { mode: 0o600 });
    const invalid = scanTraceBridges({ database, config, scannedAtMs: 4_000, budget: budget(config) });
    assert.equal(invalid[0].status, "error");
    assert.equal(invalid[0].errorCode, "TRACE_BRIDGE_EVENT_INVALID");
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention removes expired trace events but preserves current events and adapter state", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root, { ATO_RETENTION_DAYS: "45" });
    const database = openStateDatabase(config);
    const now = 100 * 24 * 60 * 60 * 1000;
    const common = {
      provider: "zcode",
      adapterId: "openadam.zcode-model-io",
      adapterVersion: "0.1.0",
      sourceId: "a".repeat(64),
      sourceFormat: "zcode-model-io-jsonl"
    };
    for (const [suffix, time] of [["expired", 1], ["current", now - 1_000]]) {
      putTraceModelStep(database, { ...common, eventId: `${suffix === "expired" ? "b" : "c"}`.repeat(64), occurredAtMs: time, status: "completed", recordedAtMs: time });
      putTraceToolEvent(database, { ...common, eventId: `${suffix === "expired" ? "d" : "e"}`.repeat(64), occurredAtMs: time, kind: "tool-call", toolName: "exec", status: "observed", recordedAtMs: time });
      putTraceTurnEvent(database, { ...common, eventId: `${suffix === "expired" ? "f" : "1"}`.repeat(64), occurredAtMs: time, status: "completed", recordedAtMs: time });
    }
    const preview = maintainDatabase(database, config, { dryRun: true }, now);
    assert.equal(preview.eligible.traceModelSteps, 1);
    assert.equal(preview.eligible.traceToolEvents, 1);
    assert.equal(preview.eligible.traceTurnEvents, 1);
    const completed = maintainDatabase(database, config, {}, now);
    assert.equal(completed.removed.traceModelSteps, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_model_step").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_tool_event").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM trace_turn_event").get().n, 1);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
