import { extractNestedToolNames, nonNegativeInteger } from "../core/classify.mjs";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { completeToolEvent, putToolEvent, putUsageEvent } from "../db.mjs";
import { ObserverError } from "../errors.mjs";
import { jsonPayloadBytes, normalizedToolFields, scanJsonlProvider } from "./jsonl-provider.mjs";

function timestampMs(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function runtimeStatus(value) {
  if (["failed", "error"].includes(value)) return "error";
  if (["cancelled", "canceled", "declined"].includes(value)) return "cancelled";
  if (["completed", "success", "succeeded"].includes(value)) return "completed";
  return "observed";
}

function createCodexParser({ database, sourceId, recordedAtMs }) {
  let sessionId = sourceId;
  let hasSessionContext = false;
  let sessionStartedAtMs = null;
  let turnId = null;
  let writes = 0;
  const callNames = new Map();

  function addTool(toolName, callId, occurredAtMs, status, derived = false, derivedIndex = 0, requestBytes = null) {
    const normalized = normalizedToolFields(toolName);
    if (!derived) callNames.set(String(callId), normalized.toolName);
    const eventId = eventIdentifier("codex", derived ? "nested-tool" : "tool", sessionId, callId, derivedIndex, normalized.toolName);
    writes += putToolEvent(database, {
      eventId,
      provider: "codex",
      sourceId,
      sessionHash: hashIdentifier("codex-session", sessionId),
      turnHash: hashIdentifier("codex-turn", turnId),
      callHash: hashIdentifier("codex-call", `${callId}:${derivedIndex}`),
      sessionStartedAtMs,
      occurredAtMs,
      completedAtMs: status === "completed" || status === "error" || status === "cancelled" ? occurredAtMs : null,
      ...normalized,
      derived,
      status,
      durationMs: null,
      retryCount: null,
      requestBytes,
      responseBytes: null,
      sourceFormat: "codex-session-jsonl",
      recordedAtMs
    });
    return eventId;
  }

  function requireSessionContext() {
    if (!hasSessionContext) {
      throw new ObserverError(
        "SOURCE_SESSION_CONTEXT_MISSING",
        "Codex records cannot be projected without their session context"
      );
    }
  }

  return {
    onRecord(record) {
      if (!record || typeof record !== "object") return;
      const payload = record.payload;
      if (record.type === "session_meta" && payload && typeof payload === "object") {
        const candidate = payload.id ?? payload.session_id;
        if (typeof candidate === "string" && candidate.length > 0) {
          sessionId = candidate;
          hasSessionContext = true;
        }
        const started = timestampMs(record.timestamp ?? payload.timestamp);
        if (started !== null) sessionStartedAtMs = sessionStartedAtMs === null ? started : Math.min(sessionStartedAtMs, started);
        return;
      }
      if (record.type === "turn_context" && payload && typeof payload === "object") {
        turnId = payload.turn_id ?? turnId;
        return;
      }
      const occurredAtMs = timestampMs(record.timestamp);
      if (record.type === "response_item" && payload && typeof payload === "object") {
        if (["custom_tool_call", "function_call", "tool_search_call", "web_search_call"].includes(payload.type)) {
          const callId = payload.call_id ?? payload.id;
          if (!callId) return;
          requireSessionContext();
          const name = payload.name ?? payload.tool_name ?? payload.type;
          const status = runtimeStatus(payload.status);
          const requestPayload = payload.input ?? payload.arguments;
          addTool(name, callId, occurredAtMs, status, false, 0, jsonPayloadBytes(requestPayload));
          if (name === "exec" && typeof payload.input === "string") {
            const nested = extractNestedToolNames(payload.input);
            nested.forEach((nestedName, index) => addTool(nestedName, callId, occurredAtMs, "observed", true, index + 1));
          }
          return;
        }
        if (["custom_tool_call_output", "function_call_output"].includes(payload.type)) {
          const callId = payload.call_id ?? payload.id;
          if (!callId) return;
          requireSessionContext();
          const key = String(callId);
          let name = callNames.get(key);
          if (name === undefined) {
            name = database.prepare(`
              SELECT tool_name FROM tool_event
              WHERE provider = 'codex' AND derived = 0
                AND session_hash = ? AND call_hash = ?
              LIMIT 1
            `).get(
              hashIdentifier("codex-session", sessionId),
              hashIdentifier("codex-call", `${key}:0`)
            )?.tool_name;
          }
          if (name === undefined) return;
          writes += completeToolEvent(
            database,
            eventIdentifier("codex", "tool", sessionId, key, 0, name),
            "completed",
            occurredAtMs ?? recordedAtMs,
            jsonPayloadBytes(payload.output)
          );
          return;
        }
      }
      if (record.type === "event_msg" && payload?.type === "token_count") {
        const usage = payload.info?.total_token_usage;
        if (!usage || typeof usage !== "object") return;
        requireSessionContext();
        const inputTokens = nonNegativeInteger(usage.input_tokens);
        const cachedInputTokens = nonNegativeInteger(usage.cached_input_tokens);
        const outputTokens = nonNegativeInteger(usage.output_tokens);
        const reasoningTokens = nonNegativeInteger(usage.reasoning_output_tokens);
        const totalTokens = nonNegativeInteger(usage.total_tokens);
        if ([inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens].every((value) => value === null)) return;
        writes += putUsageEvent(database, {
          eventId: eventIdentifier("codex", "session-usage", sessionId),
          provider: "codex",
          sessionHash: hashIdentifier("codex-session", sessionId),
          turnHash: hashIdentifier("codex-turn", turnId),
          occurredAtMs,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
          totalTokens,
          durationMs: null,
          sourceFormat: "codex-session-jsonl",
          recordedAtMs
        });
      }
    },
    eventsWritten() {
      return writes;
    },
    hasSourceContext() {
      return hasSessionContext;
    }
  };
}

export function scanCodex(options) {
  return scanJsonlProvider({
    ...options,
    provider: "codex",
    roots: options.config.codexRoots,
    limits: options.config.limits,
    minimumMtimeMs: options.minimumMtimeMs,
    primeFromStart: true,
    createParser: createCodexParser
  });
}

export { createCodexParser };
