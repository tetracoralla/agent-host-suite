import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createUiServer } from "../src/ui-server.js";
import {
  MAX_SNAPSHOT_FILE_BYTES,
  createRequest,
  readSnapshotFile,
  summarizeResult
} from "../web/app-logic.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("UI logic creates semantically distinct requests and summaries", () => {
  assert.deepEqual(createRequest("analyze", "a", "b"), { endpoint: "/api/analyze", body: { snapshotJson: "a" } });
  assert.equal(createRequest("diff", "a", "b").endpoint, "/api/diff");
  const summary = summarizeResult({ status: "error", error: { code: "BAD", message: "Bad input" } });
  assert.equal(summary.tone, "error");
  assert.equal(summary.title, "BAD");
});

test("UI summary surfaces ambiguous diff collisions as a warning", () => {
  const summary = summarizeResult({
    status: "ok",
    format: "context-surface.diff.v0.1",
    deltas: { toolCount: 2, catalogUtf8Bytes: 20 },
    tools: {
      added: [],
      removed: [],
      changed: [],
      ambiguousDueToNameCollision: [{ name: "dup", beforeCount: 0, afterCount: 2 }]
    }
  });
  assert.equal(summary.tone, "warning");
  assert.deepEqual(summary.facts, [
    "0 added",
    "0 removed",
    "0 changed",
    "1 ambiguous name collision"
  ]);
});

test("snapshot file loading preserves text and rejects oversized input before analysis", async () => {
  const snapshot = '{"format":"context-surface.snapshot.v0.1"}';
  assert.equal(await readSnapshotFile({ size: snapshot.length, text: async () => snapshot }), snapshot);
  await assert.rejects(
    readSnapshotFile({ size: MAX_SNAPSHOT_FILE_BYTES + 1, text: async () => "not read" }),
    (error) => error.code === "FILE_TOO_LARGE"
  );
  await assert.rejects(
    readSnapshotFile({ size: 1, text: async () => "x".repeat(MAX_SNAPSHOT_FILE_BYTES + 1) }),
    (error) => error.code === "FILE_TOO_LARGE"
  );
});

test("local human route serves the surface, reports invalid input, and recovers", async (t) => {
  const server = createUiServer();
  t.after(() => server.close());
  const origin = await listen(server);
  const homepage = await fetch(`${origin}/`);
  assert.equal(homepage.status, 200);
  const homepageText = await homepage.text();
  assert.match(homepageText, /Context Surface/);
  assert.match(homepageText, /aria-pressed="true"/);
  assert.match(homepageText, /rel="icon" href="data:,"/);

  const invalid = await fetch(`${origin}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotJson: "{" })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_JSON");

  const unknown = await fetch(`${origin}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotJson: "{}", invented: true })
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "UNKNOWN_FIELD");

  const wideBody = { snapshotJson: "{}", maxOutputBytes: 256 };
  for (let index = 0; index < 5000; index += 1) wideBody[`invented_${index}`] = index;
  const wideUnknown = await fetch(`${origin}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(wideBody)
  });
  const wideText = await wideUnknown.text();
  const wideResult = JSON.parse(wideText);
  assert.equal(wideUnknown.status, 400);
  assert.equal(wideResult.error.code, "UNKNOWN_FIELD");
  assert.equal(wideResult.error.details.fieldCount, 5000);
  assert.equal("fields" in wideResult.error.details, false);
  assert.ok(Buffer.byteLength(wideText) <= 256);

  const snapshot = await readFile("examples/baseline.json", "utf8");
  const recovered = await fetch(`${origin}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotJson: snapshot })
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).status, "ok");
});
