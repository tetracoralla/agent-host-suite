#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.mjs";
import { openStateDatabase } from "../src/db.mjs";
import { scanZcodeTrace } from "../src/providers/zcode-trace.mjs";
import { exportRetainedTraceAnalysisPack, listRetainedTraceSources } from "../src/retained-trace.mjs";
import { createDeepSeekEventProjector } from "../integrations/deepseek-harness/index.mjs";

const observerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parse(argumentsList) {
  const files = [];
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--json") json = true;
    else if (argumentsList[index] === "--zcode-file") {
      const value = argumentsList[++index];
      if (!value) throw new Error("--zcode-file requires an absolute file path");
      files.push(path.resolve(value));
    } else throw new Error(`unknown argument: ${argumentsList[index]}`);
  }
  if (files.length === 0 || files.length > 16) throw new Error("provide 1 to 16 --zcode-file values");
  return { files, json };
}

function percentile(values, portion) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * portion))];
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function budget(config) {
  return {
    remainingBytes: config.limits.maxBytesPerRun,
    remainingLines: config.limits.maxLinesPerRun,
    deadlineMs: Date.now() + config.limits.maxWallTimeMs
  };
}

function validateSource(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("ZCode measurement source must be absolute");
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("ZCode measurement source must be a regular non-symlinked file");
  if (!path.basename(filePath).startsWith("model-io-") || path.extname(filePath) !== ".jsonl") {
    throw new Error("ZCode measurement source must be a model-io-*.jsonl file");
  }
  return { size: info.size, mtimeMs: info.mtimeMs, identity: `${info.dev}:${info.ino}` };
}

function measureHookProcess(output) {
  const payload = JSON.stringify({
    sessionId: "performance-session",
    turnId: "performance-turn",
    toolCallId: "performance-call",
    toolName: "mcp__math_anchor__math_run",
    toolInput: { private: "TRACE_PERFORMANCE_SECRET" },
    toolResponse: { private: "TRACE_PERFORMANCE_SECRET" },
    success: true,
    timestamp: Date.now()
  });
  const durations = [];
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    const result = spawnSync(process.execPath, [
      "--no-warnings",
      path.join(observerRoot, "src", "hook-cli.mjs"),
      "--adapter", "openadam.github-copilot-cli-hooks",
      "--event", "postToolUse",
      "--output", output
    ], { input: payload, encoding: "utf8", timeout: 2_000 });
    durations.push(performance.now() - started);
    if (result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw new Error("passive hook bridge process changed its silent-success contract");
    }
  }
  const retained = fs.readFileSync(output, "utf8");
  return {
    samples: durations.length,
    processP50Ms: rounded(percentile(durations, 0.5)),
    processP95Ms: rounded(percentile(durations, 0.95)),
    eventsWritten: retained.trim().split("\n").length,
    sensitiveContentRetained: retained.includes("TRACE_PERFORMANCE_SECRET")
  };
}

function measureDeepSeekProjection() {
  const projector = createDeepSeekEventProjector({ providerVersion: "measurement" });
  const session = { header: { id: "performance-session" } };
  projector.project(session, { type: "request/header", seq: 1, time: 1, data: { header: { config: { model: "measurement" }, tools: [{ name: "exec" }] } } });
  const samples = 10_000;
  const started = performance.now();
  let events = 0;
  for (let index = 0; index < samples; index += 1) {
    events += projector.project(session, {
      type: "assistant/message",
      seq: index + 2,
      time: index + 2,
      data: { turn: index, step: 1, message: { content: [] }, usage: {} }
    }).length;
  }
  const elapsedMs = performance.now() - started;
  return { samples, events, elapsedMs: rounded(elapsedMs), eventsPerSecond: Math.round(events / (elapsedMs / 1000)) };
}

function measureRetainedTraceReads(database, config, temporary) {
  const listingDurations = [];
  let catalog = null;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    catalog = listRetainedTraceSources(database, config, { provider: "zcode", limit: 50 });
    listingDurations.push(performance.now() - started);
  }
  const session = catalog?.sources[0];
  if (!session) throw new Error("retained trace measurement requires at least one projected ZCode session");
  const exportDurations = [];
  const exportBytes = [];
  for (let index = 0; index < 5; index += 1) {
    const output = path.join(temporary, `retained-export-${index}.json`);
    const started = performance.now();
    const result = exportRetainedTraceAnalysisPack(database, config, {
      provider: "zcode",
      sessionHash: session.sessionHash,
      output
    });
    exportDurations.push(performance.now() - started);
    exportBytes.push(result.outputBytes);
  }
  return {
    sourceCatalog: {
      samples: listingDurations.length,
      sessionsReturned: catalog.sources.length,
      p50Ms: rounded(percentile(listingDurations, 0.5)),
      p95Ms: rounded(percentile(listingDurations, 0.95))
    },
    sessionExport: {
      samples: exportDurations.length,
      retainedEvents: session.totalEvents,
      p50Ms: rounded(percentile(exportDurations, 0.5)),
      p95Ms: rounded(percentile(exportDurations, 0.95)),
      maximumOutputBytes: Math.max(...exportBytes)
    }
  };
}

const options = parse(process.argv.slice(2));
const sourceBefore = options.files.map(validateSource);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openadam-trace-performance-"));
try {
  const rollout = path.join(temporary, "rollout");
  const state = path.join(temporary, "state");
  fs.mkdirSync(rollout, { recursive: true, mode: 0o700 });
  const snapshotSizes = options.files.map((filePath, index) => {
    const destination = path.join(rollout, `model-io-measurement-${index}.jsonl`);
    fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
    return fs.statSync(destination).size;
  });
  const sourceAfter = options.files.map(validateSource);
  const sourceChangedDuringSnapshot = sourceBefore.some((before, index) => (
    before.size !== sourceAfter[index].size
    || before.mtimeMs !== sourceAfter[index].mtimeMs
    || before.identity !== sourceAfter[index].identity
  ));
  const config = resolveConfig({
    ATO_STATE_DIR: state,
    ATO_ZCODE_TRACE_ROOTS: rollout
  }, path.join(temporary, "home"));
  const database = openStateDatabase(config);
  const passes = [];
  let maximumHeapUsed = process.memoryUsage().heapUsed;
  try {
    for (let pass = 0; pass < 128; pass += 1) {
      const started = performance.now();
      const health = scanZcodeTrace({
        database,
        config,
        minimumMtimeMs: 0,
        scannedAtMs: Date.now(),
        budget: budget(config)
      });
      const elapsedMs = performance.now() - started;
      maximumHeapUsed = Math.max(maximumHeapUsed, process.memoryUsage().heapUsed);
      passes.push({
        elapsedMs: rounded(elapsedMs),
        status: health.status,
        bytesRead: health.bytesRead,
        linesRead: health.linesRead,
        eventsWritten: health.eventsWritten,
        backlogSources: health.backlogSources
      });
      if (health.backlogSources === 0) break;
      if (pass === 127) throw new Error("ZCode trajectory did not settle within 128 bounded passes");
    }
    const settledDurations = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const settled = scanZcodeTrace({ database, config, minimumMtimeMs: 0, scannedAtMs: Date.now(), budget: budget(config) });
      settledDurations.push(performance.now() - started);
      if (settled.eventsWritten !== 0 || settled.bytesRead !== 0 || settled.backlogSources !== 0) {
        throw new Error("settled incremental scan performed unexpected source work");
      }
    }
    const hookOutput = path.join(temporary, "copilot-hook.jsonl");
    const hook = measureHookProcess(hookOutput);
    const retainedTraceReads = measureRetainedTraceReads(database, config, temporary);
    const report = {
      schemaVersion: "openadam.agent-tool-observer.trace-performance-measurement.v0.1",
      source: {
        files: snapshotSizes.length,
        selectedBytesBeforeSnapshot: sourceBefore.reduce((sum, value) => sum + value.size, 0),
        snapshotBytes: snapshotSizes.reduce((sum, value) => sum + value, 0),
        sourceChangedDuringSnapshot,
        pathsIncluded: false
      },
      ingestion: {
        passes: passes.length,
        coldPassMs: passes[0].elapsedMs,
        totalMs: rounded(passes.reduce((sum, item) => sum + item.elapsedMs, 0)),
        bytesRead: passes.reduce((sum, item) => sum + item.bytesRead, 0),
        boundaryRereadBytes: Math.max(0, passes.reduce((sum, item) => sum + item.bytesRead, 0) - snapshotSizes.reduce((sum, item) => sum + item, 0)),
        linesRead: passes.reduce((sum, item) => sum + item.linesRead, 0),
        projectedWrites: passes.reduce((sum, item) => sum + item.eventsWritten, 0),
        finalBacklogSources: passes.at(-1).backlogSources
      },
      settledIncremental: {
        samples: settledDurations.length,
        p50Ms: rounded(percentile(settledDurations, 0.5)),
        p95Ms: rounded(percentile(settledDurations, 0.95)),
        sourceBytesRead: 0,
        projectedWrites: 0
      },
      resource: {
        peakHeapUsedBytes: maximumHeapUsed,
        databaseBytes: fs.statSync(config.databasePath).size
      },
      retainedTraceReads,
      copilotSynchronousHook: hook,
      claudeHook: { delivery: "async", agentBlockingExpected: false, bridgeProcessCostComparableToCopilot: true },
      deepSeekProjection: measureDeepSeekProjection(),
      semantics: {
        currentMachineBaselineNotSla: true,
        passiveStorage: "metadata-only",
        interpretationStatus: "not-performed"
      }
    };
    if (hook.sensitiveContentRetained) throw new Error("hook measurement retained sensitive content");
    const output = options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2);
    process.stdout.write(`${output}\n`);
  } finally {
    database.close();
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
