import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ObserverError } from "./errors.mjs";

export const HOOK_INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const HOOK_RECORD_MAX_BYTES = 16 * 1024;

const BRIDGE_SCHEMA_VERSION = "openadam.agent-shell-trace-bridge.v0.1";
const HOOK_ADAPTERS = Object.freeze({
  "openadam.claude-code-hooks": Object.freeze({
    provider: "claude",
    version: "0.1.0",
    sourceFormat: "claude-code-hooks"
  }),
  "openadam.github-copilot-cli-hooks": Object.freeze({
    provider: "github-copilot-cli",
    version: "0.1.0",
    sourceFormat: "github-copilot-cli-hooks"
  })
});

function opaqueIdentifier(namespace, value) {
  if (value === null || value === undefined) return null;
  return createHash("sha256").update(namespace).update("\0").update(String(value)).digest("hex");
}

function jsonBytes(value) {
  if (value === undefined) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function timestampMs(value, fallback) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function boundedToolName(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown-tool";
  while (Buffer.byteLength(value) > 256) value = value.slice(0, -1);
  return value;
}

function normalizedEventName(value) {
  return String(value ?? "").replaceAll(/[^A-Za-z]/gu, "").toLowerCase();
}

function hookValue(payload, ...names) {
  for (const name of names) {
    if (payload[name] !== undefined) return payload[name];
  }
  return undefined;
}

export function projectHookEvent({ adapterId, eventName, payload, providerVersion = null, nowMs = Date.now() }) {
  const adapter = HOOK_ADAPTERS[adapterId];
  if (!adapter) throw new ObserverError("TRACE_HOOK_ADAPTER_UNSUPPORTED", "Trace hook adapter is unsupported");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ObserverError("TRACE_HOOK_INPUT_INVALID", "Trace hook input must be one JSON object");
  }
  const event = normalizedEventName(eventName || hookValue(payload, "hook_event_name", "hookEventName"));
  const supported = adapter.provider === "claude"
    ? new Set(["pretooluse", "posttooluse", "posttoolusefailure", "stop", "sessionend"])
    : new Set(["pretooluse", "posttooluse", "posttoolusefailure", "agentstop", "sessionend"]);
  if (!supported.has(event)) return [];

  const rawSessionId = hookValue(payload, "session_id", "sessionId") ?? "unknown";
  const rawTurnId = hookValue(payload, "turn_id", "turnId", "prompt_id", "promptId") ?? null;
  const rawCallId = hookValue(payload, "tool_use_id", "toolUseId", "tool_call_id", "toolCallId")
    ?? `${rawSessionId}:${event}:${hookValue(payload, "timestamp") ?? nowMs}:${hookValue(payload, "tool_name", "toolName") ?? "unknown"}`;
  const occurredAt = timestampMs(hookValue(payload, "timestamp", "created_at", "createdAt"), nowMs);
  const sessionId = opaqueIdentifier(`${adapter.provider}-hook-session`, rawSessionId);
  const turnId = opaqueIdentifier(`${adapter.provider}-hook-turn`, rawTurnId);
  const callId = opaqueIdentifier(`${adapter.provider}-hook-call`, rawCallId);
  const toolName = boundedToolName(hookValue(payload, "tool_name", "toolName"));
  const eventId = opaqueIdentifier(`${adapter.provider}-hook-event`, `${rawSessionId}:${event}:${rawCallId}:${occurredAt}`);
  const common = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    adapter: {
      id: adapterId,
      version: adapter.version,
      sourceFormat: adapter.sourceFormat,
      providerVersion: typeof providerVersion === "string" && providerVersion.length <= 100 ? providerVersion : null
    },
    provider: adapter.provider,
    eventId,
    sessionId,
    turnId,
    occurredAt,
    contentIncluded: false
  };
  if (event === "pretooluse") {
    return [{
      ...common,
      kind: "tool-call",
      callId,
      toolName,
      status: "observed",
      requestBytes: jsonBytes(hookValue(payload, "tool_input", "toolInput", "tool_args", "toolArgs"))
    }];
  }
  if (event === "posttooluse" || event === "posttoolusefailure") {
    const failed = event === "posttoolusefailure" || hookValue(payload, "success") === false;
    const result = {
      ...common,
      kind: "tool-result",
      callId,
      toolName,
      status: failed ? "error" : "completed",
      responseBytes: jsonBytes(hookValue(payload, "tool_response", "toolResponse", "tool_result", "toolResult", "error")),
      stableErrorCode: failed ? "HOOK_TOOL_FAILED" : null
    };
    if (adapter.provider !== "github-copilot-cli") return [result];
    return [{
      ...common,
      eventId: opaqueIdentifier(`${adapter.provider}-hook-event`, `${rawSessionId}:tool-call:${rawCallId}:${occurredAt}`),
      kind: "tool-call",
      callId,
      toolName,
      status: "observed",
      requestBytes: jsonBytes(hookValue(payload, "tool_input", "toolInput", "tool_args", "toolArgs"))
    }, result];
  }
  return [{
    ...common,
    kind: "turn-end",
    status: "unknown",
    stableReason: event === "agentstop" || event === "stop" ? "agent-stop-observed" : "session-end-observed"
  }];
}

function prepareAppendTarget(output) {
  if (typeof output !== "string" || !path.isAbsolute(output)) {
    throw new ObserverError("TRACE_HOOK_OUTPUT_INVALID", "Trace hook output must be an absolute path");
  }
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new ObserverError("TRACE_HOOK_OUTPUT_INVALID", "Trace hook output directory must be a real directory");
  }
  return path.resolve(output);
}

export function appendHookRecords(output, records) {
  if (!Array.isArray(records) || records.length === 0) return { eventsWritten: 0 };
  const contents = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  if (Buffer.byteLength(contents) > HOOK_RECORD_MAX_BYTES) {
    throw new ObserverError("TRACE_HOOK_RECORD_TOO_LARGE", "Projected trace hook metadata exceeded its write bound");
  }
  const target = prepareAppendTarget(output);
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(target, flags, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new ObserverError("TRACE_HOOK_OUTPUT_INVALID", "Trace hook output must be a regular file");
    fs.writeSync(descriptor, contents, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  return { eventsWritten: records.length };
}

export function processHookInput({ adapterId, eventName, output, providerVersion = null, input, nowMs = Date.now() }) {
  if (typeof input !== "string" || Buffer.byteLength(input) > HOOK_INPUT_MAX_BYTES) {
    throw new ObserverError("TRACE_HOOK_INPUT_TOO_LARGE", "Trace hook input exceeded its byte bound");
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new ObserverError("TRACE_HOOK_INPUT_INVALID", "Trace hook input must be one JSON object");
  }
  const records = projectHookEvent({ adapterId, eventName, payload, providerVersion, nowMs });
  return appendHookRecords(output, records);
}

export { HOOK_ADAPTERS };
