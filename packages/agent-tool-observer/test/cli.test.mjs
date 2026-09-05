import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../src/cli.mjs";

test("CLI rejects ignored dry-run and command-specific options before any action", () => {
  assert.throws(
    () => parseArguments(["purge", "--dry-run", "--confirm-local-data-removal"]),
    { code: "ARGUMENT_INVALID" }
  );
  assert.throws(() => parseArguments(["uninstall", "--dry-run"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["collect", "--days", "7"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["status", "--openadam"]), { code: "ARGUMENT_INVALID" });
});

test("destructive purge records both local-data and external-adapter intent", () => {
  const options = parseArguments([
    "purge",
    "--confirm-local-data-removal",
    "--confirm-external-adapters-disconnected"
  ]);
  assert.equal(options.confirmLocalDataRemoval, true);
  assert.equal(options.confirmExternalAdaptersDisconnected, true);
  assert.throws(
    () => parseArguments(["status", "--confirm-external-adapters-disconnected"]),
    { code: "ARGUMENT_INVALID" }
  );
});

test("CLI rejects duplicate options instead of silently changing intent", () => {
  assert.throws(() => parseArguments(["report", "--days", "7", "--days", "30"]), {
    code: "ARGUMENT_INVALID"
  });
  assert.throws(() => parseArguments(["collect", "--json", "--json"]), {
    code: "ARGUMENT_INVALID"
  });
});

test("CLI does not expose the retired Procedure receipt importer", () => {
  assert.throws(() => parseArguments(["ingest-receipts", "--file", "/tmp/legacy.json"]), {
    code: "ARGUMENT_INVALID"
  });
});

test("CLI requires one adapter id only for adapter-plan", () => {
  assert.equal(parseArguments(["adapter-plan", "--adapter", "openadam.zcode-model-io", "--json"]).adapter, "openadam.zcode-model-io");
  assert.throws(() => parseArguments(["adapter-plan", "--json"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["status", "--adapter", "openadam.zcode-model-io"]), { code: "ARGUMENT_INVALID" });
});

test("CLI separates retained trace discovery from exact-file and session exports", () => {
  const session = "a".repeat(64);
  const sources = parseArguments(["trace-sources", "--provider", "github-copilot-cli", "--from-ms", "10", "--to-ms", "20", "--limit", "25", "--json"]);
  assert.deepEqual(
    { command: sources.command, provider: sources.provider, fromMs: sources.fromMs, toMs: sources.toMs, limit: sources.limit, json: sources.json },
    { command: "trace-sources", provider: "github-copilot-cli", fromMs: 10, toMs: 20, limit: 25, json: true }
  );
  assert.equal(parseArguments(["trace-export", "--provider", "zcode", "--session", session, "--output", "/tmp/pack.json"]).session, session);
  assert.equal(parseArguments(["trace-export", "--provider", "zcode", "--file", "/tmp/source.jsonl", "--output", "/tmp/pack.json"]).file.endsWith("source.jsonl"), true);
  assert.throws(() => parseArguments(["trace-export", "--provider", "zcode", "--output", "/tmp/pack.json"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["trace-export", "--provider", "zcode", "--file", "/tmp/source.jsonl", "--session", session, "--output", "/tmp/pack.json"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["trace-export", "--provider", "zcode", "--file", "/tmp/source.jsonl", "--from-ms", "10", "--output", "/tmp/pack.json"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["trace-sources", "--provider", "zcode", "--max-events", "10"]), { code: "ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["trace-sources", "--provider", "ZCode"]), { code: "ARGUMENT_INVALID" });
});
