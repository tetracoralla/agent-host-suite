import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../src/constants.js";
import { executeAnalyze, executeDiff } from "../src/core.js";

function snapshot(overrides = {}) {
  return {
    format: "context-surface.snapshot.v0.1",
    source: { id: "test", revision: "1" },
    tools: [
      {
        name: "test.lookup",
        description: "Look up a value.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string" } }
        }
      }
    ],
    ...overrides
  };
}

function execute(value, limit) {
  return executeAnalyze(JSON.stringify(value), limit).result;
}

test("analyzes one bounded snapshot with exact structural metrics", () => {
  const result = execute(snapshot());
  assert.equal(result.status, "ok");
  assert.equal(result.counts.tools, 1);
  assert.equal(result.counts.schemas, 1);
  assert.match(result.snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.measurementPolicy, "reported-only; no byte-to-token inference");
});

test("canonical digest ignores object key insertion order", () => {
  const original = snapshot();
  const reordered = {
    tools: original.tools.map((tool) => ({ inputSchema: tool.inputSchema, description: tool.description, name: tool.name })),
    source: { revision: "1", id: "test" },
    format: original.format
  };
  const left = execute(original);
  const right = execute(reordered);
  assert.equal(left.snapshot.sha256, right.snapshot.sha256);
  assert.equal(left.snapshot.canonicalUtf8Bytes, right.snapshot.canonicalUtf8Bytes);
});

test("reports exact duplicate schemas, hard name collisions, and exceeded declared budgets", () => {
  const schema = { type: "object", additionalProperties: false };
  const result = execute(snapshot({
    tools: [
      { name: "same", inputSchema: schema },
      { name: "same", inputSchema: { additionalProperties: false, type: "object" } }
    ],
    budgets: { maxToolCount: 1, maxCatalogUtf8Bytes: 1, maxLargestToolUtf8Bytes: 1 }
  }));
  assert.equal(result.exactDuplicateSchemas.length, 1);
  assert.deepEqual(result.hardNameCollisions, [{ name: "same", toolIndices: [0, 1] }]);
  assert.ok(result.budgetChecks.every((check) => check.status === "exceeded"));
});

test("diffs uniquely named tools and refuses to guess collision pairs", () => {
  const before = snapshot({
    tools: [
      { name: "stable", inputSchema: { type: "string" } },
      { name: "collision", inputSchema: true },
      { name: "collision", inputSchema: false }
    ]
  });
  const after = snapshot({
    source: { id: "test", revision: "2" },
    tools: [
      { name: "stable", description: "Changed", inputSchema: { type: "string" } },
      { name: "added", inputSchema: { type: "number" } },
      { name: "collision", inputSchema: true }
    ]
  });
  const result = executeDiff(JSON.stringify(before), JSON.stringify(after)).result;
  assert.deepEqual(result.tools.added, ["added"]);
  assert.equal(result.tools.changed[0].name, "stable");
  assert.deepEqual(result.tools.ambiguousDueToNameCollision, [{ name: "collision", beforeCount: 2, afterCount: 1 }]);
  assert.equal(result.tools.reordered, null);
});

test("reports one-sided added and removed name collisions as ambiguous", () => {
  const unique = snapshot({ tools: [] });
  const colliding = snapshot({
    tools: [
      { name: "collision", inputSchema: true },
      { name: "collision", inputSchema: false }
    ]
  });

  const added = executeDiff(JSON.stringify(unique), JSON.stringify(colliding)).result;
  assert.deepEqual(added.tools.added, []);
  assert.deepEqual(added.tools.ambiguousDueToNameCollision, [
    { name: "collision", beforeCount: 0, afterCount: 2 }
  ]);

  const removed = executeDiff(JSON.stringify(colliding), JSON.stringify(unique)).result;
  assert.deepEqual(removed.tools.removed, []);
  assert.deepEqual(removed.tools.ambiguousDueToNameCollision, [
    { name: "collision", beforeCount: 2, afterCount: 0 }
  ]);
});

test("compares only token measurements with identical provenance labels", () => {
  const base = {
    metric: "input_tokens",
    value: 10,
    source: "external-counter",
    provider: "provider",
    model: "model-a",
    serialization: "catalog-json"
  };
  const before = snapshot({ measurements: [base] });
  const after = snapshot({ measurements: [{ ...base, model: "model-b", value: 20 }] });
  const result = executeDiff(JSON.stringify(before), JSON.stringify(after)).result;
  assert.deepEqual(result.tokenMeasurements.matched, []);
  assert.equal(result.tokenMeasurements.added, 1);
  assert.equal(result.tokenMeasurements.removed, 1);
});

test("rejects malformed JSON and unknown product-owned fields", () => {
  assert.throws(() => executeAnalyze("{"), (error) => error.code === "INVALID_JSON");
  assert.throws(
    () => execute(snapshot({ invented: true })),
    (error) => error.code === "UNKNOWN_FIELD" && error.details.fieldCount === 1
  );
  assert.throws(
    () => execute(snapshot({ tools: [{ name: "x", inputSchema: true, invented: true }] })),
    (error) => error.code === "UNKNOWN_FIELD"
  );
});

test("rejects oversized raw input and over-deep schemas", () => {
  const oversized = `{"padding":"${"x".repeat(LIMITS.maxSnapshotBytes)}"}`;
  assert.throws(() => executeAnalyze(oversized), (error) => error.code === "LIMIT_EXCEEDED");

  let nested = { type: "string" };
  for (let index = 0; index < LIMITS.maxSchemaDepth + 2; index += 1) nested = { child: nested };
  assert.throws(
    () => execute(snapshot({ tools: [{ name: "deep", inputSchema: nested }] })),
    (error) => error.code === "LIMIT_EXCEEDED"
  );
});

test("enforces the schema node limit cumulatively across one snapshot", () => {
  const nodeHeavySchema = { values: Array(10_000).fill(null) };
  assert.throws(
    () => execute(snapshot({
      tools: [
        { name: "nodes.a", inputSchema: nodeHeavySchema },
        { name: "nodes.b", inputSchema: nodeHeavySchema }
      ]
    })),
    (error) => error.code === "LIMIT_EXCEEDED" && error.details.limit === LIMITS.maxSchemaNodes
  );

  assert.equal(execute(snapshot()).status, "ok");
});

test("enforces a caller output budget on the complete serialized result", () => {
  assert.throws(() => executeAnalyze(JSON.stringify(snapshot()), 256), (error) => {
    assert.equal(error.code, "RESULT_BUDGET_EXCEEDED");
    assert.equal(error.details.limit, 256);
    return error.details.actual > error.details.limit;
  });
});

test("wide snapshot unknown-field errors report a count without echoing field names", () => {
  const value = snapshot();
  for (let index = 0; index < 5000; index += 1) value[`invented_${index}`] = index;
  assert.throws(() => executeAnalyze(JSON.stringify(value), 256), (error) => {
    assert.equal(error.code, "UNKNOWN_FIELD");
    assert.equal(error.details.fieldCount, 5000);
    assert.equal("fields" in error.details, false);
    return true;
  });
});

test("measurement identity keeps separator characters inside labels unambiguous", () => {
  const before = snapshot({
    measurements: [{
      metric: "input_tokens",
      value: 100,
      source: "host-observed",
      provider: "a",
      model: "b\u001fc",
      serialization: "d",
      tokenizerVersion: "e"
    }]
  });
  const after = snapshot({
    measurements: [{
      metric: "input_tokens",
      value: 999,
      source: "host-observed",
      provider: "a",
      model: "b",
      serialization: "c",
      tokenizerVersion: "d\u001fe"
    }]
  });
  const result = executeDiff(JSON.stringify(before), JSON.stringify(after)).result;
  assert.deepEqual(result.tokenMeasurements.matched, []);
  assert.equal(result.tokenMeasurements.added, 1);
  assert.equal(result.tokenMeasurements.removed, 1);
});
