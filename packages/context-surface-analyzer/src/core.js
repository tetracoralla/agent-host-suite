import { canonicalize, sha256, utf8Bytes } from "./canonical.js";
import { ANALYSIS_FORMAT, DIFF_FORMAT, LIMITS } from "./constants.js";
import { getMeasurementIdentity, parseSnapshotJson } from "./contract.js";
import { ContextSurfaceError } from "./errors.js";

function schemaMetric(schema) {
  const canonical = canonicalize(schema);
  return {
    metric: {
      sha256: sha256(canonical),
      canonicalUtf8Bytes: utf8Bytes(canonical)
    },
    canonical
  };
}

function buildBudgetCheck(metric, actual, limit) {
  return {
    metric,
    actual,
    limit,
    status: actual <= limit ? "within" : "exceeded"
  };
}

function makeDuplicateSchemas(occurrences) {
  const groups = new Map();
  for (const occurrence of occurrences) {
    const key = occurrence.canonical;
    const group = groups.get(key) ?? {
      sha256: occurrence.metric.sha256,
      canonicalUtf8Bytes: occurrence.metric.canonicalUtf8Bytes,
      occurrences: []
    };
    group.occurrences.push({ toolIndex: occurrence.toolIndex, toolName: occurrence.toolName, role: occurrence.role });
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.occurrences.length > 1)
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
}

function makeNameCollisions(tools) {
  const groups = new Map();
  tools.forEach((tool, index) => {
    const indices = groups.get(tool.name) ?? [];
    indices.push(index);
    groups.set(tool.name, indices);
  });
  return [...groups.entries()]
    .filter(([, indices]) => indices.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, toolIndices]) => ({ name, toolIndices }));
}

export function analyzeSnapshot(snapshot) {
  const canonicalSnapshot = canonicalize(snapshot);
  const canonicalCatalog = canonicalize(snapshot.tools);
  const schemaOccurrences = [];
  const toolMetrics = snapshot.tools.map((tool, index) => {
    const input = schemaMetric(tool.inputSchema);
    schemaOccurrences.push({ ...input, toolIndex: index, toolName: tool.name, role: "input" });
    const output = tool.outputSchema === undefined ? undefined : schemaMetric(tool.outputSchema);
    if (output) schemaOccurrences.push({ ...output, toolIndex: index, toolName: tool.name, role: "output" });
    return {
      index,
      name: tool.name,
      canonicalUtf8Bytes: utf8Bytes(canonicalize(tool)),
      descriptionUtf8Bytes: utf8Bytes(tool.description ?? ""),
      inputSchema: input.metric,
      ...(output ? { outputSchema: output.metric } : {})
    };
  });
  const largestToolUtf8Bytes = toolMetrics.reduce(
    (largest, tool) => Math.max(largest, tool.canonicalUtf8Bytes),
    0
  );
  const budgets = snapshot.budgets ?? {};
  const budgetChecks = [];
  if (budgets.maxCatalogUtf8Bytes !== undefined) {
    budgetChecks.push(buildBudgetCheck("catalog.canonicalUtf8Bytes", utf8Bytes(canonicalCatalog), budgets.maxCatalogUtf8Bytes));
  }
  if (budgets.maxToolCount !== undefined) {
    budgetChecks.push(buildBudgetCheck("counts.tools", snapshot.tools.length, budgets.maxToolCount));
  }
  if (budgets.maxLargestToolUtf8Bytes !== undefined) {
    budgetChecks.push(buildBudgetCheck("catalog.largestToolUtf8Bytes", largestToolUtf8Bytes, budgets.maxLargestToolUtf8Bytes));
  }

  return {
    format: ANALYSIS_FORMAT,
    status: "ok",
    source: snapshot.source,
    snapshot: {
      sha256: sha256(canonicalSnapshot),
      canonicalUtf8Bytes: utf8Bytes(canonicalSnapshot)
    },
    catalog: {
      sha256: sha256(canonicalCatalog),
      canonicalUtf8Bytes: utf8Bytes(canonicalCatalog),
      largestToolUtf8Bytes
    },
    counts: {
      tools: snapshot.tools.length,
      schemas: schemaOccurrences.length,
      describedTools: snapshot.tools.filter((tool) => tool.description !== undefined).length,
      tokenMeasurements: (snapshot.measurements ?? []).length
    },
    tools: toolMetrics,
    exactDuplicateSchemas: makeDuplicateSchemas(schemaOccurrences),
    hardNameCollisions: makeNameCollisions(snapshot.tools),
    budgetChecks,
    tokenMeasurements: snapshot.measurements ?? [],
    measurementPolicy: "reported-only; no byte-to-token inference"
  };
}

function uniqueToolsByName(snapshot) {
  const groups = new Map();
  for (const tool of snapshot.tools) {
    const values = groups.get(tool.name) ?? [];
    values.push(tool);
    groups.set(tool.name, values);
  }
  return groups;
}

function compareUniqueTools(before, after) {
  const beforeGroups = uniqueToolsByName(before);
  const afterGroups = uniqueToolsByName(after);
  const names = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  const ambiguous = [];
  for (const name of names) {
    const beforeTools = beforeGroups.get(name) ?? [];
    const afterTools = afterGroups.get(name) ?? [];
    if (beforeTools.length > 1 || afterTools.length > 1) {
      ambiguous.push({ name, beforeCount: beforeTools.length, afterCount: afterTools.length });
      continue;
    }
    if (beforeTools.length === 0) {
      added.push(name);
      continue;
    }
    if (afterTools.length === 0) {
      removed.push(name);
      continue;
    }
    const left = beforeTools[0];
    const right = afterTools[0];
    const leftCanonical = canonicalize(left);
    const rightCanonical = canonicalize(right);
    if (leftCanonical === rightCanonical) {
      unchanged.push(name);
    } else {
      changed.push({
        name,
        beforeSha256: sha256(leftCanonical),
        afterSha256: sha256(rightCanonical),
        canonicalUtf8BytesDelta: utf8Bytes(rightCanonical) - utf8Bytes(leftCanonical),
        descriptionChanged: (left.description ?? "") !== (right.description ?? ""),
        inputSchemaChanged: canonicalize(left.inputSchema) !== canonicalize(right.inputSchema),
        outputSchemaChanged: canonicalize(left.outputSchema ?? null) !== canonicalize(right.outputSchema ?? null)
      });
    }
  }
  return { added, removed, changed, unchanged, ambiguous };
}

function compareMeasurements(before, after) {
  const beforeMap = new Map((before.measurements ?? []).map((item) => [getMeasurementIdentity(item), item]));
  const afterMap = new Map((after.measurements ?? []).map((item) => [getMeasurementIdentity(item), item]));
  const identities = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const deltas = [];
  let added = 0;
  let removed = 0;
  for (const identity of identities) {
    const left = beforeMap.get(identity);
    const right = afterMap.get(identity);
    if (!left) {
      added += 1;
    } else if (!right) {
      removed += 1;
    } else {
      deltas.push({
        metric: left.metric,
        source: left.source,
        provider: left.provider,
        model: left.model,
        serialization: left.serialization,
        ...(left.tokenizerVersion ? { tokenizerVersion: left.tokenizerVersion } : {}),
        before: left.value,
        after: right.value,
        delta: right.value - left.value
      });
    }
  }
  return { matched: deltas, added, removed };
}

export function diffSnapshots(before, after) {
  const beforeAnalysis = analyzeSnapshot(before);
  const afterAnalysis = analyzeSnapshot(after);
  const toolComparison = compareUniqueTools(before, after);
  const beforeOrder = before.tools.map((tool) => tool.name);
  const afterOrder = after.tools.map((tool) => tool.name);
  const orderComparable = toolComparison.added.length === 0 &&
    toolComparison.removed.length === 0 &&
    toolComparison.ambiguous.length === 0;

  return {
    format: DIFF_FORMAT,
    status: "ok",
    before: {
      source: before.source,
      snapshotSha256: beforeAnalysis.snapshot.sha256,
      catalogUtf8Bytes: beforeAnalysis.catalog.canonicalUtf8Bytes,
      toolCount: beforeAnalysis.counts.tools,
      schemaCount: beforeAnalysis.counts.schemas,
      hardNameCollisionCount: beforeAnalysis.hardNameCollisions.length
    },
    after: {
      source: after.source,
      snapshotSha256: afterAnalysis.snapshot.sha256,
      catalogUtf8Bytes: afterAnalysis.catalog.canonicalUtf8Bytes,
      toolCount: afterAnalysis.counts.tools,
      schemaCount: afterAnalysis.counts.schemas,
      hardNameCollisionCount: afterAnalysis.hardNameCollisions.length
    },
    deltas: {
      catalogUtf8Bytes: afterAnalysis.catalog.canonicalUtf8Bytes - beforeAnalysis.catalog.canonicalUtf8Bytes,
      toolCount: afterAnalysis.counts.tools - beforeAnalysis.counts.tools,
      schemaCount: afterAnalysis.counts.schemas - beforeAnalysis.counts.schemas
    },
    tools: {
      added: toolComparison.added,
      removed: toolComparison.removed,
      changed: toolComparison.changed,
      unchanged: toolComparison.unchanged,
      ambiguousDueToNameCollision: toolComparison.ambiguous,
      reordered: orderComparable ? canonicalize(beforeOrder) !== canonicalize(afterOrder) : null
    },
    tokenMeasurements: compareMeasurements(before, after),
    measurementPolicy: "matched labels only; no byte-to-token inference"
  };
}

export function resolveResultLimit(snapshotLimits, requestedLimit) {
  const candidates = [LIMITS.defaultResultBytes];
  for (const value of [...snapshotLimits, requestedLimit]) {
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < LIMITS.minResultBytes || value > LIMITS.hardMaxResultBytes) {
        throw new ContextSurfaceError(
          "INVALID_OUTPUT_LIMIT",
          `Output limit must be a safe integer from ${LIMITS.minResultBytes} through ${LIMITS.hardMaxResultBytes}.`
        );
      }
      candidates.push(value);
    }
  }
  return Math.min(...candidates);
}

export function enforceResultBudget(result, limit) {
  const json = JSON.stringify(result);
  const actual = utf8Bytes(json);
  if (actual > limit) {
    throw new ContextSurfaceError("RESULT_BUDGET_EXCEEDED", "Serialized result exceeds the output byte limit.", {
      actual,
      limit
    });
  }
  return { result, json, utf8Bytes: actual };
}

export function executeAnalyze(snapshotJson, requestedLimit) {
  const snapshot = parseSnapshotJson(snapshotJson);
  const limit = resolveResultLimit([snapshot.budgets?.maxResultUtf8Bytes], requestedLimit);
  return { ...enforceResultBudget(analyzeSnapshot(snapshot), limit), limit };
}

export function executeDiff(beforeJson, afterJson, requestedLimit) {
  const before = parseSnapshotJson(beforeJson);
  const after = parseSnapshotJson(afterJson);
  const limit = resolveResultLimit(
    [before.budgets?.maxResultUtf8Bytes, after.budgets?.maxResultUtf8Bytes],
    requestedLimit
  );
  return { ...enforceResultBudget(diffSnapshots(before, after), limit), limit };
}
