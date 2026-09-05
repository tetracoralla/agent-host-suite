#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { collect } from "./collector.mjs";
import { ingestAgentHostDeployment } from "./agent-host-deployment.mjs";
import { resolveConfig } from "./config.mjs";
import { ingestContextSurfaceAnalysis } from "./context-surface.mjs";
import { openReadOnlyStateDatabase, openStateDatabase } from "./db.mjs";
import { ObserverError } from "./errors.mjs";
import { installLaunchAgent, purgeStateDirectory, uninstallLaunchAgent } from "./installer.mjs";
import { maintainDatabase } from "./maintenance.mjs";
import { buildReport, isCurrentReport, renderReport } from "./report.mjs";
import { readSnapshot, writeSnapshot } from "./snapshot.mjs";
import { buildStatus, renderStatus } from "./status.mjs";
import { exportTraceAnalysisPack } from "./trace-export.mjs";
import { exportRetainedTraceAnalysisPack, listRetainedTraceSources } from "./retained-trace.mjs";
import { buildAdapterPlan, listAdapterPlans } from "./adapter-plans.mjs";

process.umask(0o077);

function usage() {
  return `Usage:
  agent-tool-observer collect [--json|--quiet]
  agent-tool-observer status [--json]
  agent-tool-observer report [--days N] [--openadam] [--json]
  agent-tool-observer ingest-context-surface --file FILE [--json]
  agent-tool-observer ingest-agent-host-deployment --file FILE [--json]
  agent-tool-observer trace-sources --provider PROVIDER [--from-ms N] [--to-ms N] [--limit N] [--json]
  agent-tool-observer trace-export --provider PROVIDER (--file FILE | --session HASH) --output FILE [--from-ms N] [--to-ms N] [--include-selected-content --confirm-sensitive-content] [--max-events N] [--max-output-bytes N] [--json]
  agent-tool-observer adapters [--json]
  agent-tool-observer adapter-plan --adapter ID [--json]
  agent-tool-observer maintain [--dry-run] [--json]
  agent-tool-observer install [--dry-run] [--json]
  agent-tool-observer uninstall [--json]
  agent-tool-observer purge --confirm-local-data-removal --confirm-external-adapters-disconnected [--json]
`;
}

export function parseArguments(argumentsList) {
  const command = argumentsList[0];
  if (!command || ["help", "--help", "-h"].includes(command)) return { command: "help" };
  const options = {
    command,
    json: false,
    quiet: false,
    dryRun: false,
    openAdamOnly: false,
    days: 30,
    file: null,
    output: null,
    provider: null,
    session: null,
    fromMs: null,
    toMs: null,
    limit: 50,
    includeSelectedContent: false,
    confirmSensitiveContent: false,
    maxEvents: 500,
    maxOutputBytes: 16 * 1024 * 1024,
    confirmLocalDataRemoval: false,
    confirmExternalAdaptersDisconnected: false,
    adapter: null
  };
  const seen = new Set();
  const markSeen = (name) => {
    if (seen.has(name)) throw new ObserverError("ARGUMENT_INVALID", `${name} may appear only once`);
    seen.add(name);
  };
  for (let index = 1; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") {
      markSeen(argument);
      options.json = true;
    } else if (argument === "--quiet") {
      markSeen(argument);
      options.quiet = true;
    } else if (argument === "--dry-run") {
      markSeen(argument);
      options.dryRun = true;
    } else if (argument === "--confirm-local-data-removal") {
      markSeen(argument);
      options.confirmLocalDataRemoval = true;
    } else if (argument === "--confirm-external-adapters-disconnected") {
      markSeen(argument);
      options.confirmExternalAdaptersDisconnected = true;
    } else if (argument === "--openadam") {
      markSeen(argument);
      options.openAdamOnly = true;
    } else if (argument === "--include-selected-content") {
      markSeen(argument);
      options.includeSelectedContent = true;
    } else if (argument === "--confirm-sensitive-content") {
      markSeen(argument);
      options.confirmSensitiveContent = true;
    }
    else if (argument === "--days") {
      markSeen(argument);
      const value = Number(argumentsList[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 3650) {
        throw new ObserverError("ARGUMENT_INVALID", "--days must be an integer from 1 to 3650");
      }
      options.days = value;
    } else if (argument === "--file") {
      markSeen(argument);
      const value = argumentsList[++index];
      if (!value) throw new ObserverError("ARGUMENT_INVALID", "--file requires a path");
      options.file = path.resolve(value);
    } else if (argument === "--output") {
      markSeen(argument);
      const value = argumentsList[++index];
      if (!value) throw new ObserverError("ARGUMENT_INVALID", "--output requires a path");
      options.output = path.resolve(value);
    } else if (argument === "--provider") {
      markSeen(argument);
      const value = argumentsList[++index];
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value ?? "")) {
        throw new ObserverError("ARGUMENT_INVALID", "--provider requires a lowercase provider identifier");
      }
      options.provider = value;
    } else if (argument === "--session") {
      markSeen(argument);
      const value = argumentsList[++index];
      if (!/^[a-f0-9]{64}$/u.test(value ?? "")) {
        throw new ObserverError("ARGUMENT_INVALID", "--session requires a 64-character lowercase hexadecimal hash");
      }
      options.session = value;
    } else if (argument === "--from-ms" || argument === "--to-ms") {
      markSeen(argument);
      const value = Number(argumentsList[++index]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ObserverError("ARGUMENT_INVALID", `${argument} must be a non-negative safe integer`);
      }
      options[argument === "--from-ms" ? "fromMs" : "toMs"] = value;
    } else if (argument === "--limit") {
      markSeen(argument);
      const value = Number(argumentsList[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
        throw new ObserverError("ARGUMENT_INVALID", "--limit must be an integer from 1 to 500");
      }
      options.limit = value;
    } else if (argument === "--adapter") {
      markSeen(argument);
      const value = argumentsList[++index];
      if (!value) throw new ObserverError("ARGUMENT_INVALID", "--adapter requires an id");
      options.adapter = value;
    } else if (argument === "--max-events") {
      markSeen(argument);
      const value = Number(argumentsList[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
        throw new ObserverError("ARGUMENT_INVALID", "--max-events must be an integer from 1 to 5000");
      }
      options.maxEvents = value;
    } else if (argument === "--max-output-bytes") {
      markSeen(argument);
      const value = Number(argumentsList[++index]);
      if (!Number.isSafeInteger(value) || value < 4096 || value > 64 * 1024 * 1024) {
        throw new ObserverError("ARGUMENT_INVALID", "--max-output-bytes must be an integer from 4096 to 67108864");
      }
      options.maxOutputBytes = value;
    } else {
      throw new ObserverError("ARGUMENT_UNKNOWN", `Unknown argument: ${argument}`);
    }
  }
  if (options.json && options.quiet) {
    throw new ObserverError("ARGUMENT_INVALID", "--json and --quiet cannot be used together");
  }
  if (options.quiet && options.command !== "collect") {
    throw new ObserverError("ARGUMENT_INVALID", "--quiet is supported only by collect");
  }
  if (options.dryRun && !["install", "maintain"].includes(options.command)) {
    throw new ObserverError("ARGUMENT_INVALID", "--dry-run is supported only by install and maintain");
  }
  if (options.openAdamOnly && options.command !== "report") {
    throw new ObserverError("ARGUMENT_INVALID", "--openadam is supported only by report");
  }
  if (seen.has("--days") && options.command !== "report") {
    throw new ObserverError("ARGUMENT_INVALID", "--days is supported only by report");
  }
  const ingestionCommands = ["ingest-context-surface", "ingest-agent-host-deployment"];
  if (ingestionCommands.includes(options.command) && options.file === null) {
    throw new ObserverError("ARGUMENT_INVALID", `${options.command} requires --file`);
  }
  if (options.file !== null && ![...ingestionCommands, "trace-export"].includes(options.command)) {
    throw new ObserverError("ARGUMENT_INVALID", "--file is supported only by ingestion and trace-export commands");
  }
  const traceOnlySelected = options.output !== null || options.provider !== null
    || options.includeSelectedContent || options.confirmSensitiveContent
    || options.session !== null || options.fromMs !== null || options.toMs !== null
    || seen.has("--limit") || seen.has("--max-events") || seen.has("--max-output-bytes");
  if (traceOnlySelected && !["trace-export", "trace-sources"].includes(options.command)) {
    throw new ObserverError("ARGUMENT_INVALID", "trace selection options are supported only by trace commands");
  }
  if (options.command === "trace-sources") {
    if (options.provider === null) throw new ObserverError("ARGUMENT_INVALID", "trace-sources requires --provider");
    if (options.output !== null || options.file !== null || options.session !== null
      || options.includeSelectedContent || options.confirmSensitiveContent
      || seen.has("--max-events") || seen.has("--max-output-bytes")) {
      throw new ObserverError("ARGUMENT_INVALID", "trace-sources accepts only provider, range, limit, and output-format options");
    }
  }
  if (options.command === "trace-export") {
    if (options.output === null || options.provider === null || (options.file === null) === (options.session === null)) {
      throw new ObserverError("ARGUMENT_INVALID", "trace-export requires --provider, exactly one of --file or --session, and --output");
    }
    if (seen.has("--limit")) throw new ObserverError("ARGUMENT_INVALID", "--limit is supported only by trace-sources");
    if (options.file !== null && (options.fromMs !== null || options.toMs !== null)) {
      throw new ObserverError("ARGUMENT_INVALID", "--from-ms and --to-ms require --session");
    }
  }
  if (options.fromMs !== null && options.toMs !== null && options.fromMs > options.toMs) {
    throw new ObserverError("ARGUMENT_INVALID", "--from-ms must not be after --to-ms");
  }
  if (options.adapter !== null && options.command !== "adapter-plan") {
    throw new ObserverError("ARGUMENT_INVALID", "--adapter is supported only by adapter-plan");
  }
  if (options.command === "adapter-plan" && options.adapter === null) {
    throw new ObserverError("ARGUMENT_INVALID", "adapter-plan requires --adapter");
  }
  if (options.confirmLocalDataRemoval && options.command !== "purge") {
    throw new ObserverError("ARGUMENT_INVALID", "--confirm-local-data-removal is supported only by purge");
  }
  if (options.confirmExternalAdaptersDisconnected && options.command !== "purge") {
    throw new ObserverError("ARGUMENT_INVALID", "--confirm-external-adapters-disconnected is supported only by purge");
  }
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function renderCollect(result) {
  if (result.status === "skipped") return `Collection skipped: ${result.reason}\n`;
  const providers = result.providers.map((item) => `${item.provider}=${item.status}`).join(", ");
  return `Collection ${result.status}: ${providers}; ${result.eventsWritten} projected writes; no network or model calls.\n`;
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.command === "help") {
    process.stdout.write(usage());
    return 0;
  }
  const config = resolveConfig();
  if (options.command === "install") {
    const result = installLaunchAgent(config, { dryRun: options.dryRun });
    options.json ? printJson(result) : process.stdout.write(`LaunchAgent ${result.status}: ${result.label}\n`);
    return 0;
  }
  if (options.command === "uninstall") {
    const result = uninstallLaunchAgent(config);
    options.json ? printJson(result) : process.stdout.write("LaunchAgent uninstalled; local observations preserved.\n");
    return 0;
  }
  if (options.command === "purge") {
    if (!options.confirmLocalDataRemoval) {
      throw new ObserverError("PURGE_CONFIRMATION_REQUIRED", "purge requires --confirm-local-data-removal");
    }
    if (!options.confirmExternalAdaptersDisconnected) {
      throw new ObserverError(
        "PURGE_ADAPTER_DISCONNECT_CONFIRMATION_REQUIRED",
        "Disconnect every explicit Agent-shell adapter, then pass --confirm-external-adapters-disconnected"
      );
    }
    if (["darwin", "win32"].includes(os.platform())) uninstallLaunchAgent(config);
    const result = purgeStateDirectory(config);
    options.json ? printJson(result) : process.stdout.write("Observer service and local observation data removed.\n");
    return 0;
  }

  if (options.command === "trace-sources") {
    const database = openReadOnlyStateDatabase(config);
    let result;
    try {
      result = listRetainedTraceSources(database, config, {
        provider: options.provider,
        fromMs: options.fromMs,
        toMs: options.toMs,
        limit: options.limit
      });
    } finally {
      database.close();
    }
    if (options.json) printJson(result);
    else process.stdout.write(`${result.sources.length} retained ${result.provider} trace sessions; metadata only; completeness remains unknown.\n`);
    return 0;
  }

  if (options.command === "trace-export") {
    let result;
    if (options.session !== null) {
      const database = openReadOnlyStateDatabase(config);
      try {
        result = exportRetainedTraceAnalysisPack(database, config, {
          provider: options.provider,
          sessionHash: options.session,
          output: options.output,
          fromMs: options.fromMs,
          toMs: options.toMs,
          includeSelectedContent: options.includeSelectedContent,
          confirmSensitiveContent: options.confirmSensitiveContent,
          maxEvents: options.maxEvents,
          maxOutputBytes: options.maxOutputBytes
        });
      } finally {
        database.close();
      }
    } else {
      result = exportTraceAnalysisPack({
        provider: options.provider,
        file: options.file,
        output: options.output,
        includeSelectedContent: options.includeSelectedContent,
        confirmSensitiveContent: options.confirmSensitiveContent,
        limits: { maxEvents: options.maxEvents, maxOutputBytes: options.maxOutputBytes }
      });
    }
    if (options.json) printJson(result);
    else process.stdout.write(
      `Trace Analysis Pack written: ${result.eventsReturned} bounded events; ${result.contentPolicy}; Observer did not retain the pack.\n`
    );
    return 0;
  }

  if (options.command === "adapters") {
    const result = listAdapterPlans();
    if (options.json) printJson(result);
    else process.stdout.write(`${result.adapters.length} trace adapters; configuration and interpretation remain explicit.\n`);
    return 0;
  }

  if (options.command === "adapter-plan") {
    const result = buildAdapterPlan(config, options.adapter);
    if (options.json) printJson(result);
    else process.stdout.write(`Adapter plan for ${result.adapter.id}; no Agent-shell configuration was changed.\n`);
    return 0;
  }

  if (options.command === "collect") {
    const database = openStateDatabase(config);
    try {
      const result = collect(database, config);
      try {
        writeSnapshot(config, "latest-report.json", buildReport(database, { days: 30 }));
        writeSnapshot(config, "latest-status.json", buildStatus(database, config));
        result.snapshots = { status: "completed" };
      } catch (error) {
        result.status = result.status === "error" ? "error" : "partial";
        result.snapshots = {
          status: "error",
          errorCode: error instanceof ObserverError ? error.code : "SNAPSHOT_WRITE_FAILED",
          collectionCommitted: true
        };
      }
      if (options.json) printJson(result);
      else if (!options.quiet) process.stdout.write(renderCollect(result));
      return 0;
    } finally {
      database.close();
    }
  }
  if (options.command === "maintain") {
    const database = openStateDatabase(config);
    try {
      const result = maintainDatabase(database, config, { dryRun: options.dryRun });
      if (!options.dryRun) {
        writeSnapshot(config, "latest-report.json", buildReport(database, { days: config.limits.lookbackDays }));
        writeSnapshot(config, "latest-status.json", buildStatus(database, config));
      }
      if (options.json) printJson(result);
      else process.stdout.write(
        options.dryRun
          ? `Maintenance preview: ${Object.values(result.eligible).reduce((sum, value) => sum + value, 0)} rows eligible; no data changed.\n`
          : `Maintenance completed: ${Object.values(result.removed).reduce((sum, value) => sum + value, 0)} rows removed; ${result.reclaimedFileBytes ?? "unknown"} database bytes reclaimed.\n`
      );
      return 0;
    } finally {
      database.close();
    }
  }
  if (options.command === "ingest-context-surface") {
    const database = openStateDatabase(config);
    try {
      const result = ingestContextSurfaceAnalysis(database, options.file);
      try {
        writeSnapshot(config, "latest-report.json", buildReport(database, { days: 30 }));
        result.snapshots = { status: "completed" };
      } catch (error) {
        result.status = "partial";
        result.snapshots = {
          status: "error",
          errorCode: error instanceof ObserverError ? error.code : "SNAPSHOT_WRITE_FAILED",
          ingestionCommitted: true
        };
      }
      if (options.json) printJson(result);
      else process.stdout.write(
        `Context Surface ingestion ${result.status}: ${result.measurementsWritten} explicit measurement written; raw catalog and schemas not stored.\n`
      );
      return 0;
    } finally {
      database.close();
    }
  }
  if (options.command === "ingest-agent-host-deployment") {
    const database = openStateDatabase(config);
    try {
      const result = ingestAgentHostDeployment(database, options.file);
      try {
        writeSnapshot(config, "latest-report.json", buildReport(database, { days: 30 }));
        writeSnapshot(config, "latest-status.json", buildStatus(database, config));
        result.snapshots = { status: "completed" };
      } catch (error) {
        result.status = "partial";
        result.snapshots = {
          status: "error",
          errorCode: error instanceof ObserverError ? error.code : "SNAPSHOT_WRITE_FAILED",
          ingestionCommitted: true
        };
      }
      if (options.json) printJson(result);
      else process.stdout.write(
        `Agent Host deployment ingestion ${result.status}: ${result.deploymentsWritten} immutable release observation written; raw content and source paths not stored.\n`
      );
      return 0;
    } finally {
      database.close();
    }
  }
  if (options.command === "status") {
    let result;
    try {
      result = readSnapshot(config, "latest-status.json");
    } catch {
      const database = openReadOnlyStateDatabase(config);
      try {
        result = buildStatus(database, config);
      } finally {
        database.close();
      }
    }
    options.json ? printJson(result) : process.stdout.write(renderStatus(result));
    return 0;
  }
  if (options.command === "report") {
    let result;
    if (options.days === 30 && !options.openAdamOnly) {
      try {
        result = readSnapshot(config, "latest-report.json");
        if (!isCurrentReport(result)) throw new ObserverError("SNAPSHOT_STALE", "report snapshot uses an older schema");
      } catch {
        result = null;
      }
    }
    if (result === null || result === undefined) {
      const database = openReadOnlyStateDatabase(config);
      try {
        result = buildReport(database, options);
      } finally {
        database.close();
      }
    }
    options.json ? printJson(result) : process.stdout.write(renderReport(result));
    return 0;
  }
  throw new ObserverError("COMMAND_UNKNOWN", `Unknown command: ${options.command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const code = error instanceof ObserverError ? error.code : "OBSERVER_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", error: { code, message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
