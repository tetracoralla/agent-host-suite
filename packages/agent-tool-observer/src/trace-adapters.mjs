import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObserverError } from "./errors.mjs";

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "adapters");
const COVERAGE = new Set(["available", "partial", "unavailable"]);
const TRANSPORTS = new Set(["public-events", "opentelemetry", "official-hooks", "stable-local-records", "aggregate-store"]);
const SIGNALS = ["modelSteps", "toolOffers", "toolCalls", "toolResults", "usage", "turnEnds", "selfReportedRationalePresence"];

function validateAdapter(value, fileName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} must contain one object`);
  }
  if (value.schemaVersion !== "openadam.agent-shell-adapter.v0.1") {
    throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} uses an unsupported schema version`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(value.id ?? "") || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.version ?? "")) {
    throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} has an invalid identity`);
  }
  if (!TRANSPORTS.has(value.transport)) throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} has an invalid transport`);
  for (const signal of SIGNALS) {
    if (!COVERAGE.has(value.signals?.[signal])) throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} has invalid ${signal} coverage`);
  }
  if (value.content?.passiveStorage !== "metadata-only") {
    throw new ObserverError("TRACE_ADAPTER_INVALID", `${fileName} must keep passive storage metadata-only`);
  }
  return Object.freeze(value);
}

function loadAdapters() {
  let entries;
  try {
    entries = fs.readdirSync(adapterRoot, { withFileTypes: true });
  } catch (error) {
    throw new ObserverError("TRACE_ADAPTER_CATALOG_MISSING", "Trace adapter catalog is unavailable", { cause: error.code });
  }
  const adapters = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => validateAdapter(JSON.parse(fs.readFileSync(path.join(adapterRoot, entry.name), "utf8")), entry.name))
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  const ids = new Set();
  for (const adapter of adapters) {
    if (ids.has(adapter.id)) throw new ObserverError("TRACE_ADAPTER_DUPLICATE", `Duplicate trace adapter id: ${adapter.id}`);
    ids.add(adapter.id);
  }
  return Object.freeze(adapters);
}

export const TRACE_ADAPTERS = loadAdapters();

export function traceAdapterById(id) {
  return TRACE_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

export function negotiatedTraceAdapters(healthRows = [], providerRows = []) {
  const health = new Map(healthRows.map((row) => [row.adapter_id, row]));
  const providers = new Map(providerRows.map((row) => [row.provider, row]));
  return TRACE_ADAPTERS.map((adapter) => {
    const row = health.get(adapter.id);
    const provider = providers.get(adapter.provider);
    const fallbackStatus = ["codex", "claude"].includes(adapter.provider)
      ? provider?.status ?? "unconfigured"
      : "unconfigured";
    return {
      ...adapter,
      runtime: {
        ...adapter.runtime,
        status: row?.status ?? fallbackStatus,
        errorCode: row?.error_code ?? provider?.error_code ?? null,
        providerVersion: row?.provider_version ?? null,
        scannedAtMs: row ? Number(row.scanned_at_ms) : provider ? Number(provider.scanned_at_ms) : null,
        filesSeen: Number(row?.files_seen ?? provider?.files_seen ?? 0),
        filesRead: Number(row?.files_read ?? provider?.files_read ?? 0),
        bytesRead: Number(row?.bytes_read ?? provider?.bytes_read ?? 0),
        linesRead: Number(row?.lines_read ?? provider?.lines_read ?? 0),
        eventsWritten: Number(row?.events_written ?? provider?.events_written ?? 0),
        skippedLines: Number(row?.skipped_lines ?? provider?.skipped_lines ?? 0),
        backlogSources: Number(row?.backlog_sources ?? provider?.backlog_sources ?? 0)
      }
    };
  });
}
