import {
  databaseStats,
  directRuntimeHealth,
  latestAgentHostDeployment,
  latestCollection,
  providerHealth,
  traceAdapterHealth
} from "./db-read.mjs";
import { negotiatedTraceAdapters } from "./trace-adapters.mjs";

export function buildStatus(database, config) {
  const directRuntime = directRuntimeHealth(database);
  const deployment = latestAgentHostDeployment(database);
  const providerRows = providerHealth(database);
  const traceRows = traceAdapterHealth(database);
  return {
    state: databaseStats(database),
    latestCollection: latestCollection(database),
    providers: providerRows.map((row) => ({
      provider: row.provider,
      status: row.status,
      errorCode: row.error_code,
      filesSeen: Number(row.files_seen),
      filesRead: Number(row.files_read),
      bytesRead: Number(row.bytes_read),
      linesRead: Number(row.lines_read),
      eventsWritten: Number(row.events_written),
      skippedLines: Number(row.skipped_lines),
      backlogSources: Number(row.backlog_sources),
      scannedAtMs: Number(row.scanned_at_ms)
    })),
    traceAdapters: negotiatedTraceAdapters(traceRows, providerRows),
    semanticSources: directRuntime ? [{
      source: directRuntime.source,
      status: directRuntime.status,
      errorCode: directRuntime.error_code,
      filesSeen: Number(directRuntime.files_seen),
      filesRead: Number(directRuntime.files_read),
      bytesRead: Number(directRuntime.bytes_read),
      linesRead: Number(directRuntime.lines_read),
      eventsWritten: Number(directRuntime.events_written),
      skippedLines: Number(directRuntime.skipped_lines),
      backlogSources: Number(directRuntime.backlog_sources),
      scannedAtMs: Number(directRuntime.scanned_at_ms)
    }] : [],
    currentAgentHostDeployment: deployment ? {
      observedAtMs: Number(deployment.observed_at_ms),
      activatedAtMs: Number(deployment.activated_at_ms),
      channel: deployment.channel,
      releaseId: deployment.release_id,
      suiteVersion: deployment.suite_version,
      profile: deployment.profile
    } : null,
    automaticIntervalSeconds: 300,
    databasePath: config.databasePath,
    privacy: { rawContentStored: false, sourcePathsStored: false, networkUsed: false, modelCalls: 0 }
  };
}

export function renderStatus(status) {
  const lines = [
    `Tool events: ${status.state.toolEvents}; usage events: ${status.state.usageEvents}; sources: ${status.state.sources}`,
    `Latest collection: ${status.latestCollection?.status ?? "never"}`
  ];
  for (const provider of status.providers) {
    lines.push(`${provider.provider}: ${provider.status}${provider.errorCode ? ` (${provider.errorCode})` : ""}`);
  }
  for (const source of status.semanticSources ?? []) {
    lines.push(`${source.source}: ${source.status}${source.errorCode ? ` (${source.errorCode})` : ""}`);
  }
  for (const adapter of status.traceAdapters ?? []) {
    lines.push(`trace ${adapter.provider}/${adapter.id}: ${adapter.runtime.status}${adapter.runtime.errorCode ? ` (${adapter.runtime.errorCode})` : ""}`);
  }
  lines.push("Privacy: metadata only; no source paths/raw content; no network/model calls.");
  lines.splice(2, 0, `Current Agent Host deployment: ${status.currentAgentHostDeployment?.releaseId ?? "not observed"}`);
  return `${lines.join("\n")}\n`;
}
