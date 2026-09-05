import { classifyTool } from "../core/classify.mjs";
import { hashIdentifier } from "../core/hash.mjs";
import { discoverJsonlFiles, readJsonlIncremental } from "../core/jsonl-reader.mjs";
import { getCursor, putCursor } from "../db.mjs";
import { ObserverError, stableErrorCode } from "../errors.mjs";

export function normalizedToolFields(toolName) {
  const classified = classifyTool(toolName);
  return {
    toolName: classified.toolName,
    toolNamespace: classified.namespace,
    routeClass: classified.routeClass,
    isOpenAdam: classified.isOpenAdam
  };
}

export function jsonPayloadBytes(value) {
  if (value === undefined) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return typeof serialized === "string" ? Buffer.byteLength(serialized) : null;
}

function emptyHealth(provider, scannedAtMs) {
  return {
    provider,
    status: "ok",
    errorCode: null,
    filesSeen: 0,
    filesRead: 0,
    bytesRead: 0,
    linesRead: 0,
    eventsWritten: 0,
    skippedLines: 0,
    backlogSources: 0,
    scannedAtMs
  };
}

export function scanJsonlProvider(options) {
  const health = emptyHealth(options.provider, options.scannedAtMs);
  let discovery;
  try {
    discovery = discoverJsonlFiles(options.roots, {
      maximumFiles: options.limits.maxFilesPerProvider,
      minimumMtimeMs: options.minimumMtimeMs
    });
  } catch (error) {
    return { ...health, status: "error", errorCode: stableErrorCode(error, "SOURCE_DISCOVERY_FAILED") };
  }
  health.filesSeen = discovery.files.length;
  if (discovery.presentRoots === 0) return { ...health, status: "missing", errorCode: "SOURCE_ROOT_MISSING" };
  if (discovery.truncated || discovery.skippedSymlinks > 0) health.status = "partial";
  let sourceFailures = 0;

  for (const file of discovery.files) {
    if (options.budget.remainingBytes <= 0 || options.budget.remainingLines <= 0 || Date.now() >= options.budget.deadlineMs) {
      health.status = "partial";
      health.backlogSources += 1;
      continue;
    }
    const sourceId = hashIdentifier(`source:${options.provider}`, file.filePath);
    const cursor = getCursor(options.database, sourceId);
    const identityMatches = cursor?.file_identity === file.fileIdentity;
    const sizeMatches = cursor && cursor.offset_bytes <= file.sizeBytes;
    const startOffset = identityMatches && sizeMatches ? cursor.offset_bytes : 0;
    const discardingLine = identityMatches && sizeMatches && cursor.discarding_line === 1;
    if (startOffset === file.sizeBytes && !discardingLine) continue;
    const parser = options.createParser({
      database: options.database,
      sourceId,
      recordedAtMs: options.scannedAtMs
    });
    let maximumBytes = Math.min(options.limits.maxBytesPerSource, options.budget.remainingBytes);
    let maximumLines = Math.min(options.limits.maxLinesPerRun, options.budget.remainingLines);
    const allocatedBytes = maximumBytes;
    const allocatedLines = maximumLines;
    try {
      options.database.exec("BEGIN IMMEDIATE");
      let primeResult = null;
      if (options.primeFromStart && startOffset > 0) {
        primeResult = readJsonlIncremental({
          filePath: file.filePath,
          startOffset: 0,
          discardingLine: false,
          expectedIdentity: null,
          maximumBytes: Math.min(64 * 1024, file.sizeBytes, maximumBytes),
          maximumLineBytes: options.limits.maxLineBytes,
          maximumLines: Math.min(8, maximumLines),
          maximumDepth: options.limits.maxJsonDepth,
          deadlineMs: options.budget.deadlineMs,
          onRecord: parser.onRecord
        });
        if (typeof parser.hasSourceContext === "function" && !parser.hasSourceContext()) {
          throw new ObserverError(
            "SOURCE_SESSION_CONTEXT_MISSING",
            "Incremental source context could not be recovered within the bounded prefix"
          );
        }
        maximumBytes -= primeResult.bytesRead;
        maximumLines -= primeResult.linesRead;
      }
      const result = readJsonlIncremental({
        filePath: file.filePath,
        startOffset,
        discardingLine,
        expectedIdentity: identityMatches ? file.fileIdentity : null,
        maximumBytes,
        maximumLineBytes: options.limits.maxLineBytes,
        maximumLines,
        maximumDepth: options.limits.maxJsonDepth,
        deadlineMs: options.budget.deadlineMs,
        onRecord: parser.onRecord
      });
      putCursor(options.database, {
        sourceId,
        provider: options.provider,
        fileIdentity: result.fileIdentity,
        offsetBytes: result.nextOffset,
        sizeBytes: result.sizeBytes,
        mtimeMs: result.mtimeMs,
        discardingLine: result.discardingLine,
        skippedLines: result.skippedLines,
        updatedAtMs: options.scannedAtMs
      });
      options.database.exec("COMMIT");
      health.filesRead += 1;
      const totalBytesRead = (primeResult?.bytesRead ?? 0) + result.bytesRead;
      const totalLinesRead = (primeResult?.linesRead ?? 0) + result.linesRead;
      health.bytesRead += totalBytesRead;
      health.linesRead += totalLinesRead;
      health.eventsWritten += parser.eventsWritten();
      health.skippedLines += result.skippedLines;
      if (result.hasBacklog) health.backlogSources += 1;
      options.budget.remainingBytes -= totalBytesRead;
      options.budget.remainingLines -= totalLinesRead;
    } catch (error) {
      if (options.database.isTransaction) options.database.exec("ROLLBACK");
      options.budget.remainingBytes = Math.max(0, options.budget.remainingBytes - allocatedBytes);
      options.budget.remainingLines = Math.max(0, options.budget.remainingLines - allocatedLines);
      sourceFailures += 1;
      health.errorCode ??= stableErrorCode(error);
    }
  }
  if (sourceFailures > 0) health.status = health.filesRead > 0 ? "partial" : "error";
  if (health.skippedLines > 0 || health.backlogSources > 0) health.status = health.status === "error" ? "error" : "partial";
  return health;
}
