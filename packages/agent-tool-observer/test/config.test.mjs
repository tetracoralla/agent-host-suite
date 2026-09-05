import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.mjs";

const home = path.resolve("/tmp/agent-tool-observer-config-home");

test("default source budget uses the full four-way share of the bounded run", () => {
  const config = resolveConfig({}, home);
  assert.equal(config.limits.maxBytesPerSource, 32 * 1024 * 1024);
  assert.equal(config.limits.maxBytesPerRun, 128 * 1024 * 1024);
  assert.equal(config.limits.maxWallTimeMs, 90_000);
  assert.equal(config.limits.leaseMs, 120_000);
});

test("collector lease always outlives the configured wall-time bound", () => {
  assert.equal(resolveConfig({ ATO_MAX_WALL_MS: "180000" }, home).limits.leaseMs, 210_000);
  assert.equal(resolveConfig({ ATO_MAX_WALL_MS: "180000", ATO_LEASE_MS: "240000" }, home).limits.leaseMs, 240_000);
  assert.throws(
    () => resolveConfig({ ATO_MAX_WALL_MS: "180000", ATO_LEASE_MS: "180000" }, home),
    { code: "CONFIG_INVALID" }
  );
});

test("configuration rejects misspelled disabled providers", () => {
  assert.throws(
    () => resolveConfig({ ATO_DISABLE_PROVIDERS: "codxe" }, home),
    { code: "CONFIG_INVALID" }
  );
});

test("provider source overrides require unambiguous absolute paths", () => {
  for (const [name, value] of [
    ["ATO_CODEX_ROOTS", "relative/codex"],
    ["ATO_CLAUDE_ROOTS", "relative/claude"],
    ["ATO_ZCODE_DB", "relative/zcode.sqlite"],
    ["ATO_DIRECT_RUNTIME_LOGS", "relative/observations.jsonl"],
    ["ATO_DIRECT_RUNTIME_LOGS", `/tmp/one${path.delimiter}`]
  ]) {
    assert.throws(() => resolveConfig({ [name]: value }, home), { code: "CONFIG_INVALID" });
  }
});
