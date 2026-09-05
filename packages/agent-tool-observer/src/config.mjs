import os from "node:os";
import path from "node:path";
import { ObserverError } from "./errors.mjs";

const MACOS_STATE_DIR_PARTS = [
  "Library",
  "Application Support",
  "OpenAdam",
  "Agent Tool Observer"
];

function defaultStateDir(environment, homeDirectory) {
  if (os.platform() === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local"), "openAdam", "Agent Tool Observer");
  }
  return path.join(homeDirectory, ...MACOS_STATE_DIR_PARTS);
}

function defaultDirectRuntimeLog(environment, homeDirectory) {
  if (os.platform() === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local"), "openAdam", "Direct Execution Runtime", "observations.jsonl");
  }
  return path.join(homeDirectory, "Library", "Application Support", "OpenAdam", "Direct Execution Runtime", "observations.jsonl");
}

export const DEFAULT_LIMITS = Object.freeze({
  lookbackDays: 30,
  retentionDays: 45,
  maxFilesPerProvider: 2_000,
  maxBytesPerSource: 32 * 1024 * 1024,
  maxBytesPerRun: 128 * 1024 * 1024,
  maxLinesPerRun: 250_000,
  maxLineBytes: 2 * 1024 * 1024,
  maxJsonDepth: 64,
  maxWallTimeMs: 90_000,
  leaseMs: 2 * 60_000
});

const LEASE_GRACE_MS = 30_000;

function integerSetting(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverError("CONFIG_INVALID", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

const PROVIDERS = new Set(["codex", "claude", "zcode", "direct-runtime"]);

function absolutePath(value, name) {
  if (!path.isAbsolute(value)) {
    throw new ObserverError("CONFIG_INVALID", `${name} must contain absolute paths`);
  }
  return path.resolve(value);
}

function pathList(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const items = value.split(path.delimiter).map((item) => item.trim());
  if (items.length === 0 || items.some((item) => item.length === 0)) {
    throw new ObserverError("CONFIG_INVALID", `${name} must contain non-empty absolute paths`);
  }
  return items.map((item) => absolutePath(item, name));
}

export function resolveConfig(environment = process.env, homeDirectory = os.homedir()) {
  const stateDir = path.resolve(
    environment.ATO_STATE_DIR || defaultStateDir(environment, homeDirectory)
  );
  const lookbackDays = integerSetting(environment.ATO_LOOKBACK_DAYS, DEFAULT_LIMITS.lookbackDays, 1, 3650, "ATO_LOOKBACK_DAYS");
  const retentionDays = integerSetting(environment.ATO_RETENTION_DAYS, DEFAULT_LIMITS.retentionDays, 1, 3650, "ATO_RETENTION_DAYS");
  if (retentionDays < lookbackDays) {
    throw new ObserverError("CONFIG_INVALID", "ATO_RETENTION_DAYS must be greater than or equal to ATO_LOOKBACK_DAYS");
  }
  const maxWallTimeMs = integerSetting(environment.ATO_MAX_WALL_MS, DEFAULT_LIMITS.maxWallTimeMs, 1000, 30 * 60_000, "ATO_MAX_WALL_MS");
  const leaseMs = integerSetting(
    environment.ATO_LEASE_MS,
    Math.max(DEFAULT_LIMITS.leaseMs, maxWallTimeMs + LEASE_GRACE_MS),
    10_000,
    60 * 60_000,
    "ATO_LEASE_MS"
  );
  if (leaseMs <= maxWallTimeMs) {
    throw new ObserverError("CONFIG_INVALID", "ATO_LEASE_MS must exceed ATO_MAX_WALL_MS");
  }
  const limits = {
    lookbackDays,
    retentionDays,
    maxFilesPerProvider: integerSetting(environment.ATO_MAX_FILES, DEFAULT_LIMITS.maxFilesPerProvider, 1, 100_000, "ATO_MAX_FILES"),
    maxBytesPerSource: integerSetting(environment.ATO_MAX_SOURCE_BYTES, DEFAULT_LIMITS.maxBytesPerSource, 4096, 128 * 1024 * 1024, "ATO_MAX_SOURCE_BYTES"),
    maxBytesPerRun: integerSetting(environment.ATO_MAX_RUN_BYTES, DEFAULT_LIMITS.maxBytesPerRun, 4096, 2 * 1024 * 1024 * 1024, "ATO_MAX_RUN_BYTES"),
    maxLinesPerRun: integerSetting(environment.ATO_MAX_LINES, DEFAULT_LIMITS.maxLinesPerRun, 4, 5_000_000, "ATO_MAX_LINES"),
    maxLineBytes: integerSetting(environment.ATO_MAX_LINE_BYTES, DEFAULT_LIMITS.maxLineBytes, 1024, 32 * 1024 * 1024, "ATO_MAX_LINE_BYTES"),
    maxJsonDepth: integerSetting(environment.ATO_MAX_JSON_DEPTH, DEFAULT_LIMITS.maxJsonDepth, 4, 512, "ATO_MAX_JSON_DEPTH"),
    maxWallTimeMs,
    leaseMs
  };
  const disabledProviderNames =
    String(environment.ATO_DISABLE_PROVIDERS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  const unknownProvider = disabledProviderNames.find((provider) => !PROVIDERS.has(provider));
  if (unknownProvider !== undefined) {
    throw new ObserverError("CONFIG_INVALID", `ATO_DISABLE_PROVIDERS contains unknown provider: ${unknownProvider}`);
  }
  const disabledProviders = new Set(disabledProviderNames);
  return Object.freeze({
    stateDir,
    databasePath: path.join(stateDir, "observer.sqlite3"),
    logsDir: path.join(stateDir, "logs"),
    codexRoots: pathList(environment.ATO_CODEX_ROOTS, [
      path.join(homeDirectory, ".codex", "sessions"),
      path.join(homeDirectory, ".codex", "archived_sessions")
    ], "ATO_CODEX_ROOTS"),
    claudeRoots: pathList(environment.ATO_CLAUDE_ROOTS, [
      path.join(homeDirectory, ".claude", "projects")
    ], "ATO_CLAUDE_ROOTS"),
    zcodeDatabasePath: environment.ATO_ZCODE_DB
      ? absolutePath(environment.ATO_ZCODE_DB, "ATO_ZCODE_DB")
      : path.join(homeDirectory, ".zcode", "cli", "db", "db.sqlite"),
    zcodeTraceRoots: pathList(environment.ATO_ZCODE_TRACE_ROOTS, [
      path.join(homeDirectory, ".zcode", "cli", "rollout")
    ], "ATO_ZCODE_TRACE_ROOTS"),
    traceBridgeLogs: pathList(environment.ATO_TRACE_BRIDGE_LOGS, [
      path.join(stateDir, "bridges", "deepseek-harness.jsonl"),
      path.join(stateDir, "bridges", "github-copilot-cli.jsonl"),
      path.join(stateDir, "bridges", "claude-hooks.jsonl")
    ], "ATO_TRACE_BRIDGE_LOGS"),
    geminiTelemetryLogs: pathList(environment.ATO_GEMINI_TELEMETRY_LOGS, [
      path.join(stateDir, "bridges", "gemini-cli-otel.log")
    ], "ATO_GEMINI_TELEMETRY_LOGS"),
    directRuntimeLogs: pathList(environment.ATO_DIRECT_RUNTIME_LOGS, [
      defaultDirectRuntimeLog(environment, homeDirectory)
    ], "ATO_DIRECT_RUNTIME_LOGS"),
    disabledProviders,
    limits
  });
}
