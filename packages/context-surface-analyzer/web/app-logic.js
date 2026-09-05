export const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

function fileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function readSnapshotFile(file) {
  if (!file) return null;
  if (Number.isFinite(file.size) && file.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw fileError("FILE_TOO_LARGE", "Snapshot file exceeds the 512 KiB input limit.");
  }
  let text;
  try {
    text = await file.text();
  } catch {
    throw fileError("FILE_READ_FAILED", "Snapshot file could not be read.");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_FILE_BYTES) {
    throw fileError("FILE_TOO_LARGE", "Snapshot file exceeds the 512 KiB input limit.");
  }
  return text;
}

export function createRequest(mode, beforeText, afterText) {
  if (mode === "analyze") {
    return { endpoint: "/api/analyze", body: { snapshotJson: beforeText } };
  }
  if (mode === "diff") {
    return {
      endpoint: "/api/diff",
      body: { beforeSnapshotJson: beforeText, afterSnapshotJson: afterText }
    };
  }
  throw new Error("Unsupported UI mode.");
}

export function summarizeResult(result) {
  if (result.status === "error") {
    return { tone: "error", title: result.error.code, facts: [result.error.message] };
  }
  if (result.format === "context-surface.analysis.v0.1") {
    return {
      tone: result.hardNameCollisions.length > 0 || result.budgetChecks.some((check) => check.status === "exceeded")
        ? "warning"
        : "ok",
      title: `${result.counts.tools} tools · ${result.catalog.canonicalUtf8Bytes} bytes`,
      facts: [
        `${result.counts.schemas} schemas`,
        `${result.hardNameCollisions.length} name collisions`,
        `${result.exactDuplicateSchemas.length} duplicate schema groups`
      ]
    };
  }
  const ambiguousCollisions = result.tools.ambiguousDueToNameCollision.length;
  const facts = [
    `${result.tools.added.length} added`,
    `${result.tools.removed.length} removed`,
    `${result.tools.changed.length} changed`
  ];
  if (ambiguousCollisions > 0) {
    facts.push(`${ambiguousCollisions} ambiguous name collision${ambiguousCollisions === 1 ? "" : "s"}`);
  }
  return {
    tone: ambiguousCollisions > 0 ? "warning" : "ok",
    title: `${result.deltas.toolCount >= 0 ? "+" : ""}${result.deltas.toolCount} tools · ${result.deltas.catalogUtf8Bytes >= 0 ? "+" : ""}${result.deltas.catalogUtf8Bytes} bytes`,
    facts
  };
}
