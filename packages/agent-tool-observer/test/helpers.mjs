import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.mjs";

export function temporaryRoot(prefix = "agent-tool-observer-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fixtureConfig(root, overrides = {}) {
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const codex = path.join(root, "codex");
  const claude = path.join(root, "claude");
  const zcode = path.join(root, "zcode.sqlite");
  const zcodeTrace = path.join(root, "zcode-rollout");
  const directRuntime = path.join(root, "direct-runtime.jsonl");
  for (const directory of [home, codex, claude, zcodeTrace]) fs.mkdirSync(directory, { recursive: true });
  const environment = {
    ATO_STATE_DIR: state,
    ATO_CODEX_ROOTS: codex,
    ATO_CLAUDE_ROOTS: claude,
    ATO_ZCODE_DB: zcode,
    ATO_ZCODE_TRACE_ROOTS: zcodeTrace,
    ATO_GEMINI_TELEMETRY_LOGS: path.join(root, "bridges", "gemini-cli-otel.log"),
    ATO_DIRECT_RUNTIME_LOGS: directRuntime,
    ATO_LOOKBACK_DAYS: "30",
    ...overrides
  };
  return {
    config: resolveConfig(environment, home),
    paths: { home, state, codex, claude, zcode, zcodeTrace, directRuntime },
    environment
  };
}

export function writeJsonl(filePath, records, finalNewline = true) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (finalNewline ? "\n" : "");
  fs.writeFileSync(filePath, text, { mode: 0o600 });
}
