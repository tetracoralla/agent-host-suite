import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

function run(args) {
  return spawnSync(process.execPath, ["src/cli.js", ...args], { cwd: process.cwd(), encoding: "utf8" });
}

test("CLI analyzes and diffs the example snapshots", () => {
  const analysis = run(["analyze", "examples/baseline.json"]);
  assert.equal(analysis.status, 0, analysis.stderr);
  assert.equal(JSON.parse(analysis.stdout).format, "context-surface.analysis.v0.1");

  const diff = run(["diff", "examples/baseline.json", "examples/updated.json"]);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).format, "context-surface.diff.v0.1");
});

test("CLI returns one stable JSON error for invalid input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-surface-cli-"));
  const path = join(directory, "invalid.json");
  await writeFile(path, "{", "utf8");
  const result = run(["analyze", path]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_JSON");
});

test("CLI bounds wide validation errors to the requested output limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-surface-cli-wide-"));
  const path = join(directory, "wide.json");
  const value = { format: "context-surface.snapshot.v0.1", source: { id: "wide" }, tools: [] };
  for (let index = 0; index < 5000; index += 1) value[`invented_${index}`] = index;
  await writeFile(path, JSON.stringify(value), "utf8");
  const result = run(["analyze", path, "--max-output-bytes", "256"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "UNKNOWN_FIELD");
  assert.ok(Buffer.byteLength(result.stdout.trim()) <= 256);
});
