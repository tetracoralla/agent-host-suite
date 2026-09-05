import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { collect } from "../src/collector.mjs";
import { ingestContextSurfaceAnalysis } from "../src/context-surface.mjs";
import { ingestAgentHostDeployment } from "../src/agent-host-deployment.mjs";
import { openStateDatabase, putToolEvent } from "../src/db.mjs";
import { buildReport } from "../src/report.mjs";
import { maintainDatabase } from "../src/maintenance.mjs";
import { fixtureConfig, temporaryRoot, writeJsonl } from "./helpers.mjs";

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function directObservation(overrides = {}) {
  return {
    schemaVersion: "openadam.direct-execution-observation.v0.1",
    eventId: digest("a"),
    workOrderHash: digest("b"),
    callHash: digest("c"),
    occurredAtMs: 1_777_000_000_000,
    completedAtMs: 1_777_000_000_012,
    target: {
      kind: "capability",
      capabilityId: "org.openadam.test.echo",
      capabilityVersion: "0.1.0",
      operationId: "echo"
    },
    provider: {
      id: "org.openadam.test-provider",
      version: "0.1.0",
      transport: "capability-jsonl-v0.1",
      lifecycle: "persistent"
    },
    status: "ok",
    errorCode: null,
    timingMs: { total: 12, queue: 1, providerRoundTrip: 8 },
    payloadBytes: { request: 17, response: 21 },
    sessionState: "cold",
    bindingDigest: digest("d"),
    contractDigest: digest("e"),
    execution: {
      modelCalls: 0,
      tokenUsage: null,
      monetaryCost: null,
      externalCostStatus: "not_observed"
    },
    ...overrides
  };
}

test("Direct Runtime metadata is collected idempotently without work-order content", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root, { ATO_DISABLE_PROVIDERS: "codex,claude,zcode" });
    writeJsonl(paths.directRuntime, [directObservation()]);
    const database = openStateDatabase(config);
    const first = collect(database, config, 1_777_000_000_100);
    const second = collect(database, config, 1_777_000_000_200);
    assert.equal(first.semanticSources[0].status, "ok");
    assert.equal(first.semanticSources[0].eventsWritten, 1);
    assert.equal(second.semanticSources[0].eventsWritten, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM semantic_execution_event").get().n, 1);
    const stored = JSON.stringify(database.prepare("SELECT * FROM semantic_execution_event").get());
    assert.equal(stored.includes("work-order-private-input"), false);
    const report = buildReport(database, { days: 1 }, 1_777_000_000_200);
    assert.equal(report.semanticExecutions.length, 1);
    assert.equal(report.semanticExecutions[0].target.capabilityId, "org.openadam.test.echo");
    assert.equal(report.semanticExecutions[0].payload.requestBytes, 17);
    assert.equal(report.semanticExecutions[0].executionCost.modelCalls, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Direct Runtime projected MCP operations retain carrier and operation identity", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root, { ATO_DISABLE_PROVIDERS: "codex,claude,zcode" });
    writeJsonl(paths.directRuntime, [directObservation({
      eventId: digest("f"),
      target: {
        kind: "mcp-operation",
        toolName: "math.run",
        operationId: "calculus.derivative"
      },
      provider: {
        id: "io.github.tetracoralla.math-anchor",
        version: "0.3.0",
        transport: "mcp-stdio",
        lifecycle: "persistent"
      }
    })]);
    const database = openStateDatabase(config);
    const collected = collect(database, config, 1_777_000_000_100);
    assert.equal(collected.semanticSources[0].status, "ok");
    assert.equal(collected.semanticSources[0].eventsWritten, 1);
    const report = buildReport(database, { days: 1 }, 1_777_000_000_200);
    assert.deepEqual(report.semanticExecutions[0].target, {
      kind: "mcp-operation",
      toolName: "math.run",
      operationId: "calculus.derivative"
    });
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Direct Runtime observation drift fails closed before cursor advancement", () => {
  const root = temporaryRoot();
  try {
    const { config, paths } = fixtureConfig(root, { ATO_DISABLE_PROVIDERS: "codex,claude,zcode" });
    writeJsonl(paths.directRuntime, [{ ...directObservation(), unknown: true }]);
    const database = openStateDatabase(config);
    const result = collect(database, config, 1_777_000_000_100);
    assert.equal(result.semanticSources[0].status, "error");
    assert.equal(result.semanticSources[0].errorCode, "DIRECT_OBSERVATION_INVALID");
    assert.equal(database.prepare("SELECT count(*) AS n FROM semantic_execution_event").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM direct_runtime_cursor").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one collection shares its total byte and line budgets across every source family", () => {
  const root = temporaryRoot();
  try {
    const firstDirect = path.join(root, "direct-one.jsonl");
    const secondDirect = path.join(root, "direct-two.jsonl");
    const { config, paths } = fixtureConfig(root, {
      ATO_DIRECT_RUNTIME_LOGS: [firstDirect, secondDirect].join(path.delimiter),
      ATO_MAX_RUN_BYTES: "4096",
      ATO_MAX_LINES: "4"
    });
    writeJsonl(path.join(paths.codex, "budget.jsonl"), [
      { timestamp: "2026-04-25T00:00:00.000Z", type: "session_meta", payload: { id: "budget-codex" } },
      ...Array.from({ length: 12 }, (_, index) => ({
        timestamp: "2026-04-25T00:00:01.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: `c${index}`, name: "exec", status: "completed", input: "x".repeat(300) }
      }))
    ]);
    writeJsonl(path.join(paths.claude, "budget.jsonl"), Array.from({ length: 12 }, (_, index) => ({
      timestamp: "2026-04-25T00:00:00.000Z",
      type: "assistant",
      sessionId: "budget-claude",
      uuid: `u${index}`,
      message: { id: `m${index}`, usage: { input_tokens: 1, output_tokens: 1 }, content: [] }
    })));
    writeJsonl(firstDirect, [directObservation({ eventId: digest("1") }), directObservation({ eventId: digest("2") })]);
    writeJsonl(secondDirect, [directObservation({ eventId: digest("3") }), directObservation({ eventId: digest("4") })]);

    const database = openStateDatabase(config);
    const result = collect(database, config, Date.parse("2026-04-25T01:00:00.000Z"));
    const sources = [...result.providers, ...result.semanticSources];
    assert.equal(sources.reduce((sum, source) => sum + source.bytesRead, 0) <= config.limits.maxBytesPerRun, true);
    assert.equal(sources.reduce((sum, source) => sum + source.linesRead, 0) <= config.limits.maxLinesPerRun, true);
    assert.equal(sources.some((source) => source.backlogSources > 0), true);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Direct Runtime source consumes its allocation before later files are considered", () => {
  const root = temporaryRoot();
  try {
    const invalid = path.join(root, "direct-invalid.jsonl");
    const later = path.join(root, "direct-later.jsonl");
    const { config } = fixtureConfig(root, {
      ATO_DISABLE_PROVIDERS: "codex,claude,zcode",
      ATO_DIRECT_RUNTIME_LOGS: [invalid, later].join(path.delimiter),
      ATO_MAX_RUN_BYTES: "4096",
      ATO_MAX_LINES: "4"
    });
    writeJsonl(invalid, [{ ...directObservation(), unknown: true }]);
    writeJsonl(later, [directObservation({ eventId: digest("6") })]);
    const database = openStateDatabase(config);
    const result = collect(database, config, 1_777_000_000_100);
    assert.equal(result.semanticSources[0].status, "error");
    assert.equal(result.semanticSources[0].backlogSources, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM semantic_execution_event").get().n, 0);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Context Surface analysis import stores only bounded measurements and provenance", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const file = path.join(root, "analysis.json");
    const analysis = {
      format: "context-surface.analysis.v0.1",
      status: "ok",
      source: { id: "sample-plugin", revision: "1.0.0" },
      snapshot: { sha256: "a".repeat(64), canonicalUtf8Bytes: 828 },
      catalog: { sha256: "b".repeat(64), canonicalUtf8Bytes: 410, largestToolUtf8Bytes: 205 },
      counts: { tools: 2, schemas: 2, describedTools: 2, tokenMeasurements: 1 },
      tools: [{ name: "must-not-store" }],
      exactDuplicateSchemas: [{ sha256: "c".repeat(64) }],
      hardNameCollisions: [],
      budgetChecks: [],
      tokenMeasurements: [{
        metric: "input_tokens",
        value: 412,
        source: "external-counter",
        provider: "example-provider",
        model: "example-model",
        serialization: "tools-list-json",
        tokenizerVersion: "example-1"
      }],
      measurementPolicy: "reported-only; no byte-to-token inference"
    };
    fs.writeFileSync(file, JSON.stringify(analysis), { mode: 0o600 });
    const database = openStateDatabase(config);
    const first = ingestContextSurfaceAnalysis(database, file, 1000);
    const second = ingestContextSurfaceAnalysis(database, file, 2000);
    assert.equal(first.measurementsWritten, 1);
    assert.equal(second.measurementsWritten, 0);
    const stored = JSON.stringify(database.prepare("SELECT * FROM context_surface_measurement").get());
    assert.equal(stored.includes("must-not-store"), false);
    const report = buildReport(database, { days: 1 }, 3000);
    assert.equal(report.contextSurfaces[0].catalog.canonicalUtf8Bytes, 410);
    assert.equal(report.contextSurfaces[0].tokenMeasurements[0].model, "example-model");
    assert.equal(report.contextSurfaces[0].currentInstalledBindingStatus, "not_assessed");
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent Host deployment correlates the active immutable release without storing paths or task content", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const file = path.join(root, "deployment.json");
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: "openadam.agent-host-deployment-observation.v0.1",
      observedAtMs: 2_000,
      activatedAtMs: 1_000,
      channel: "release",
      releaseId: "release-3",
      suiteVersion: "0.3.0",
      profile: "local-dogfood",
      components: [{
        id: "math-anchor",
        version: "0.4.0",
        artifactSha256: "d".repeat(64),
        toolNames: ["math.run"]
      }],
      context: {
        sourceId: "agent-host:math-anchor",
        sourceRevision: "release-3",
        catalogSha256: "e".repeat(64),
        catalogBytes: 321,
        toolCount: 1
      }
    }), { mode: 0o600 });
    const database = openStateDatabase(config);
    assert.equal(ingestAgentHostDeployment(database, file).deploymentsWritten, 1);
    const laterObservation = JSON.parse(fs.readFileSync(file, "utf8"));
    laterObservation.observedAtMs = 2_500;
    fs.writeFileSync(file, JSON.stringify(laterObservation), { mode: 0o600 });
    assert.equal(ingestAgentHostDeployment(database, file).deploymentsWritten, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM agent_host_deployment_observation").get().n, 1);
    assert.equal(database.prepare("SELECT observed_at_ms FROM agent_host_deployment_observation").get().observed_at_ms, 2_500);
    putToolEvent(database, {
      eventId: "release-call",
      provider: "codex",
      sessionHash: "fresh-session",
      turnHash: "fresh-turn",
      sessionStartedAtMs: 1_200,
      occurredAtMs: 1_500,
      toolName: "mcp__math_anchor__math_run",
      toolNamespace: "math_anchor",
      routeClass: "mcp",
      isOpenAdam: true,
      status: "completed",
      sourceFormat: "test",
      recordedAtMs: 1_500
    });
    putToolEvent(database, {
      eventId: "preceding-shell",
      provider: "codex",
      sessionHash: "fresh-session",
      turnHash: "fresh-turn",
      sessionStartedAtMs: 1_200,
      occurredAtMs: 1_400,
      toolName: "exec",
      routeClass: "orchestration",
      isOpenAdam: false,
      status: "completed",
      sourceFormat: "test",
      recordedAtMs: 1_400
    });
    putToolEvent(database, {
      eventId: "ambiguous-release-call",
      provider: "codex",
      sessionHash: "old-session",
      turnHash: "old-turn",
      sessionStartedAtMs: 900,
      occurredAtMs: 1_600,
      toolName: "mcp__math_anchor__math_run",
      toolNamespace: "math_anchor",
      routeClass: "mcp",
      isOpenAdam: true,
      status: "completed",
      sourceFormat: "test",
      recordedAtMs: 1_600
    });
    putToolEvent(database, {
      eventId: "suffix-collision",
      provider: "codex",
      sessionHash: "fresh-session",
      turnHash: "different-turn",
      sessionStartedAtMs: 1_200,
      occurredAtMs: 1_700,
      toolName: "mcp__unrelated__not_math_run",
      toolNamespace: "unrelated",
      routeClass: "mcp",
      isOpenAdam: true,
      status: "completed",
      sourceFormat: "test",
      recordedAtMs: 1_700
    });
    const report = buildReport(database, { days: 1 }, 3_000);
    assert.equal(report.currentAgentHostDeployment.releaseId, "release-3");
    const tool = report.tools.find((item) => item.toolName === "mcp__math_anchor__math_run");
    assert.equal(tool.currentAgentHostDeployment.componentVersion, "0.4.0");
    assert.equal(tool.currentAgentHostDeployment.status, "fresh-session-observed");
    assert.equal(tool.currentAgentHostDeployment.callsSinceActivation, 2);
    assert.equal(tool.currentAgentHostDeployment.freshSessionCallsSinceActivation, 1);
    assert.equal(tool.currentAgentHostDeployment.preActivationSessionCallsSinceActivation, 1);
    assert.equal(tool.currentAgentHostDeployment.unknownSessionStartCallsSinceActivation, 0);
    assert.equal(tool.currentAgentHostDeployment.ambiguousSessionCallsSinceActivation, 1);
    const codexCoverage = report.freshSessionCorrelation.providers.find((item) => item.provider === "codex");
    assert.equal(codexCoverage.coverageStatus, "complete-for-observed-calls");
    assert.equal(codexCoverage.freshSessionCallsSinceActivation, 1);
    assert.equal(report.freshSessionCorrelation.providers.find((item) => item.provider === "claude").coverageStatus, "no-current-release-tool-calls-observed");
    assert.equal(report.routingObservations.length, 1);
    assert.equal(report.freshSessionCorrelation.routing.observationRecordsReturned, 1);
    assert.equal(report.freshSessionCorrelation.routing.observationRecordsTruncated, false);
    assert.equal(report.routingObservations[0].currentReleaseToolFirst, false);
    assert.equal(report.routingObservations[0].precedingShellOrOrchestrationCalls, 1);
    assert.equal(report.tools.find((item) => item.toolName === "mcp__unrelated__not_math_run").currentAgentHostDeployment.status, "outside-current-agent-host-deployment");
    const stored = JSON.stringify(database.prepare("SELECT * FROM agent_host_deployment_observation").get());
    assert.equal(stored.includes(root), false);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh-session routing reports bounded observation records instead of a false total", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const file = path.join(root, "deployment.json");
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: "openadam.agent-host-deployment-observation.v0.1",
      observedAtMs: 2_000,
      activatedAtMs: 1_000,
      channel: "release",
      releaseId: "release-routing-bound",
      suiteVersion: "0.3.0",
      profile: "local-dogfood",
      components: [{
        id: "math-anchor",
        version: "0.4.0",
        artifactSha256: "d".repeat(64),
        toolNames: ["math.run"]
      }],
      context: null
    }), { mode: 0o600 });
    const database = openStateDatabase(config);
    ingestAgentHostDeployment(database, file);
    for (let index = 0; index < 101; index += 1) {
      putToolEvent(database, {
        eventId: `routing-bound-${index}`,
        provider: "codex",
        sessionHash: `session-${index}`,
        turnHash: `turn-${index}`,
        sessionStartedAtMs: 1_100,
        occurredAtMs: 1_200 + index,
        toolName: "mcp__math_anchor__math_run",
        routeClass: "mcp",
        isOpenAdam: true,
        status: "completed",
        sourceFormat: "test",
        recordedAtMs: 1_200 + index
      });
    }
    const report = buildReport(database, { days: 1 }, 3_000);
    assert.equal(report.routingObservations.length, 100);
    assert.deepEqual(report.freshSessionCorrelation.routing, {
      observationRecordsReturned: 100,
      observationRecordLimit: 100,
      observationRecordsTruncated: true,
      matchingTurnsInScannedEvents: 101,
      sourceEventsScanned: 101,
      sourceEventLimit: 50_000,
      sourceEventsTruncated: false
    });
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orchestration wrappers and derived nested calls cannot create repeated tool-sequence observations", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const now = Date.now();
    for (let turn = 0; turn < 4; turn += 1) {
      for (const [position, event] of [
        { toolName: "exec", routeClass: "orchestration", derived: false },
        { toolName: "exec_command", routeClass: "orchestration", derived: true },
        { toolName: "mcp__math_anchor__math_run", routeClass: "mcp", derived: true }
      ].entries()) {
        putToolEvent(database, {
          eventId: `wrapper-${turn}-${position}`,
          provider: "codex",
          sessionHash: `session-${turn % 2}`,
          turnHash: `turn-${turn}`,
          callHash: `call-${turn}-${position}`,
          occurredAtMs: now + turn * 10 + position,
          ...event,
          isOpenAdam: event.toolName.includes("math_anchor"),
          status: "completed",
          sourceFormat: "test",
          recordedAtMs: now
        });
      }
    }
    const report = buildReport(database, { days: 1 }, now + 1000);
    assert.deepEqual(report.portfolio.repeatedToolSequences, []);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repeated passive patterns remain neutral observations without Capability or Procedure nominations", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const database = openStateDatabase(config);
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      putToolEvent(database, {
        eventId: `unmapped-${index}`,
        provider: "codex",
        sessionHash: `unmapped-session-${index % 2}`,
        turnHash: `unmapped-turn-${index}`,
        callHash: `unmapped-call-${index}`,
        occurredAtMs: now + index,
        toolName: "mcp__unmapped__transform",
        routeClass: "mcp",
        isOpenAdam: false,
        derived: false,
        status: "completed",
        sourceFormat: "test",
        recordedAtMs: now,
      });
    }
    for (let turn = 0; turn < 3; turn += 1) {
      for (const [position, toolName] of ["mcp__alpha__read", "mcp__beta__write"].entries()) {
        putToolEvent(database, {
          eventId: `sequence-${turn}-${position}`,
          provider: "codex",
          sessionHash: `sequence-session-${turn % 2}`,
          turnHash: `sequence-turn-${turn}`,
          callHash: `sequence-call-${turn}-${position}`,
          occurredAtMs: now + 100 + turn * 10 + position,
          toolName,
          routeClass: "mcp",
          isOpenAdam: false,
          derived: false,
          status: "completed",
          sourceFormat: "test",
          recordedAtMs: now,
        });
      }
    }

    const report = buildReport(database, { days: 1 }, now + 1000);
    assert.deepEqual(report.portfolio.repeatedUnmappedMcpUse, [{
      provider: "codex",
      toolName: "mcp__unmapped__transform",
      calls: 5,
      signal: "repeated-unmapped-mcp-use",
      basis: "repeated-unmapped-mcp-use",
      correctnessStatus: "unknown",
      interpretationStatus: "not-performed",
    }]);
    assert.deepEqual(report.portfolio.repeatedToolSequences, [{
      provider: "codex",
      sequence: ["mcp__alpha__read", "mcp__beta__write"],
      observedTurns: 3,
      observedSessions: 2,
      signal: "repeated-tool-sequence",
      correctnessStatus: "unknown",
      interpretationStatus: "not-performed",
    }]);
    for (const actionField of [
      "fixCandidates",
      "capabilityCandidates",
      "procedureCandidates",
      "weakenRoutingCandidates",
      "retireCandidates",
    ]) {
      assert.equal(Object.hasOwn(report.portfolio, actionField), false);
    }
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance previews and removes only observations older than the retained window", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root, { ATO_RETENTION_DAYS: "45" });
    const database = openStateDatabase(config);
    const now = 100 * 24 * 60 * 60 * 1000;
    for (const [eventId, occurredAtMs] of [["expired", 1], ["current", now - 1000]]) {
      putToolEvent(database, {
        eventId,
        provider: "codex",
        occurredAtMs,
        toolName: "mcp__math_anchor__math_run",
        routeClass: "mcp",
        isOpenAdam: true,
        status: "completed",
        sourceFormat: "test",
        recordedAtMs: occurredAtMs
      });
    }
    const preview = maintainDatabase(database, config, { dryRun: true }, now);
    assert.equal(preview.eligible.toolEvents, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM tool_event").get().n, 2);
    const completed = maintainDatabase(database, config, {}, now);
    assert.equal(completed.removed.toolEvents, 1);
    assert.deepEqual(database.prepare("SELECT event_id FROM tool_event").all().map((row) => row.event_id), ["current"]);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
