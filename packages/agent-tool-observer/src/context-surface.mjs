import fs from "node:fs";
import { hashIdentifier } from "./core/hash.mjs";
import { putContextSurfaceMeasurement } from "./db.mjs";
import { ObserverError } from "./errors.mjs";

const MAX_ANALYSIS_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", `${label} must be an object`);
  }
  return value;
}

function boundedString(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", `${label} is invalid`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", `${label} is invalid`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", `${label} is invalid`);
  }
  return value;
}

function tokenMeasurements(value) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", "tokenMeasurements is invalid");
  }
  return value.map((item, index) => {
    object(item, `tokenMeasurements[${index}]`);
    const allowed = new Set(["metric", "value", "source", "provider", "model", "serialization", "tokenizerVersion"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      throw new ObserverError("CONTEXT_SURFACE_INVALID", "tokenMeasurements contains an unknown field");
    }
    const normalized = {
      metric: boundedString(item.metric, 100, "token metric"),
      value: count(item.value, "token value"),
      source: boundedString(item.source, 200, "token source")
    };
    for (const field of ["provider", "model", "serialization", "tokenizerVersion"]) {
      if (item[field] !== undefined) normalized[field] = boundedString(item[field], 200, field);
    }
    return normalized;
  });
}

function normalizeAnalysis(analysis, importedAtMs) {
  object(analysis, "analysis");
  if (analysis.format !== "context-surface.analysis.v0.1" || analysis.status !== "ok") {
    throw new ObserverError("CONTEXT_SURFACE_UNSUPPORTED", "Only successful Context Surface analysis v0.1 is supported");
  }
  const source = object(analysis.source, "source");
  const snapshot = object(analysis.snapshot, "snapshot");
  const catalog = object(analysis.catalog, "catalog");
  const counts = object(analysis.counts, "counts");
  const sourceId = boundedString(source.id, 200, "source.id");
  const sourceRevision = boundedString(source.revision, 200, "source.revision");
  const snapshotSha256 = sha256(snapshot.sha256, "snapshot.sha256");
  const catalogSha256 = sha256(catalog.sha256, "catalog.sha256");
  const measurementId = hashIdentifier(
    "context-surface-measurement",
    `${sourceId}\0${sourceRevision}\0${snapshotSha256}\0${catalogSha256}`
  );
  return {
    measurementId,
    sourceId,
    sourceRevision,
    snapshotSha256,
    snapshotBytes: count(snapshot.canonicalUtf8Bytes, "snapshot.canonicalUtf8Bytes"),
    catalogSha256,
    catalogBytes: count(catalog.canonicalUtf8Bytes, "catalog.canonicalUtf8Bytes"),
    largestToolBytes: count(catalog.largestToolUtf8Bytes, "catalog.largestToolUtf8Bytes"),
    toolCount: count(counts.tools, "counts.tools"),
    schemaCount: count(counts.schemas, "counts.schemas"),
    describedToolCount: count(counts.describedTools, "counts.describedTools"),
    duplicateSchemaCount: Array.isArray(analysis.exactDuplicateSchemas) ? analysis.exactDuplicateSchemas.length : 0,
    hardNameCollisionCount: Array.isArray(analysis.hardNameCollisions) ? analysis.hardNameCollisions.length : 0,
    tokenMeasurements: tokenMeasurements(analysis.tokenMeasurements ?? []),
    sourceFormat: analysis.format,
    importedAtMs
  };
}

export function ingestContextSurfaceAnalysis(database, filePath, importedAtMs = Date.now()) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (error) {
    throw new ObserverError("CONTEXT_SURFACE_FILE_UNAVAILABLE", "Context Surface analysis file is unavailable", { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ANALYSIS_BYTES) {
    throw new ObserverError("CONTEXT_SURFACE_FILE_INVALID", "Context Surface analysis must be a bounded regular non-symlinked file");
  }
  let analysis;
  try {
    analysis = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ObserverError("CONTEXT_SURFACE_INVALID", "Context Surface analysis is not valid JSON", { cause: error });
  }
  const normalized = normalizeAnalysis(analysis, importedAtMs);
  const written = putContextSurfaceMeasurement(database, normalized);
  return {
    status: "completed",
    measurementsWritten: written,
    source: { id: normalized.sourceId, revision: normalized.sourceRevision },
    snapshotSha256: normalized.snapshotSha256,
    catalogBytes: normalized.catalogBytes,
    rawCatalogStored: false,
    rawSchemasStored: false
  };
}

export { normalizeAnalysis };
